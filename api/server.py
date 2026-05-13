# ============================================================
# api/server.py
# FastAPI & Native WebSockets bridge for React Heimdall Dashboard.
# ============================================================

import asyncio
import logging
import math
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import StreamingResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from database.alert_db import (
    fetch_all_stations,
    fetch_all_alerts,
    fetch_drones_for_station,
    mark_observed,
    release_active_dispatch,
    update_drone_status,
)
from database.path_db import delete_paths_for_incident, fetch_all_paths
from state import fleet_state

logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

API_HOST = os.getenv("HEIMDALL_API_HOST", "0.0.0.0")
API_PORT = int(os.getenv("HEIMDALL_API_PORT", "5001"))

app = FastAPI(title="Heimdall API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── SIMULATION CONFIG ────────────────────────────────────────────────────────

# How many times faster than real-time to run the simulation.
# At 50 km/h a 2 km path takes ~144s. SPEED_SCALE=20 compresses it to ~7s.
SIMULATION_SPEED_SCALE: float = 20.0

# Minimum sleep between telemetry broadcasts (seconds). Controls smoothness.
MIN_BROADCAST_INTERVAL: float = 0.5  # 2 Hz — smooth enough for map UI, reduces React render pressure by 5×

# ── WEBSOCKET MANAGER ────────────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, event_name: str, data: dict):
        """Sends a structured JSON payload to all connected React clients."""
        payload = {"event": event_name, "data": data}
        dead = []
        for connection in self.active_connections:
            try:
                await connection.send_json(payload)
            except Exception:
                dead.append(connection)
        for c in dead:
            self.disconnect(c)


manager = ConnectionManager()

_simulation_tasks_by_mission: dict[str, asyncio.Task] = {}
_simulation_tasks_by_drone: dict[str, asyncio.Task] = {}


def _mission_id(dispatch_data: dict) -> str:
    dispatch_id = dispatch_data.get("dispatch_id")
    if dispatch_id:
        return str(dispatch_id)
    return f"{dispatch_data.get('drone_id', 'drone')}:{dispatch_data.get('alert_id', 'alert')}"


def _as_float(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(number):
        return fallback
    return number


def _normalise_waypoint_times(waypoints: list[dict]) -> list[dict]:
    """Return waypoints with strictly increasing timestamps."""
    if len(waypoints) < 2:
        return waypoints

    speed_ms = 50.0 * (1000 / 3600)
    normalised: list[dict] = []
    elapsed = 0.0

    for idx, wp in enumerate(waypoints):
        next_wp = dict(wp)
        if idx == 0:
            next_wp["timestamp"] = 0.0
            normalised.append(next_wp)
            continue

        prev = normalised[-1]
        raw_time = _as_float(wp.get("timestamp"), elapsed)
        min_delta = _haversine(
            _as_float(prev.get("latitude")),
            _as_float(prev.get("longitude")),
            _as_float(wp.get("latitude")),
            _as_float(wp.get("longitude")),
        ) / speed_ms
        delta = max(raw_time - elapsed, min_delta, 0.05)
        elapsed += delta
        next_wp["timestamp"] = round(elapsed, 3)
        normalised.append(next_wp)

    return normalised


def _station_payload() -> list[dict]:
    stations = fetch_all_stations()
    for station in stations:
        drones = []
        for drone in fetch_drones_for_station(station["id"]):
            telemetry = fleet_state.get_telemetry(drone["id"])
            live_status = telemetry.get("status") or drone["status"]
            drones.append({
                "id": drone["id"],
                "status": live_status,
                "load_count": drone["load_count"],
                "battery": round(_as_float(telemetry.get("battery"), 100.0), 1),
                "latitude": _as_float(telemetry.get("lat")),
                "longitude": _as_float(telemetry.get("lon")),
                "altitude": _as_float(telemetry.get("altitude")),
                "speed": _as_float(telemetry.get("speed")),
                "progress": _as_float(telemetry.get("progress")),
                "return_progress": _as_float(telemetry.get("return_progress")),
                "phase": telemetry.get("phase") or live_status,
                "mission_id": telemetry.get("mission_id"),
            })
        station["drones"] = drones
    return stations


def _zone_is_active(zone: dict) -> bool:
    active_from = zone.get("active_from") or ""
    active_until = zone.get("active_until") or ""
    if not active_from or not active_until:
        return True
    try:
        now = datetime.now()
        return datetime.strptime(active_from, "%Y-%m-%d %H:%M") <= now <= datetime.strptime(active_until, "%Y-%m-%d %H:%M")
    except ValueError:
        return True


def _zone_geometry(zone: dict):
    try:
        from shapely.geometry import Point, Polygon
    except Exception:
        return None

    shape = zone.get("shape", "circle")
    if shape == "circle" and zone.get("center") and zone.get("radius_m"):
        lat, lon = zone["center"]
        return Point(float(lon), float(lat)).buffer(float(zone["radius_m"]) / 111_000.0, resolution=40)
    if shape == "polygon" and zone.get("polygon"):
        poly = Polygon([(float(lon), float(lat)) for lat, lon in zone["polygon"]])
        return poly if poly.is_valid else poly.buffer(0)
    return None


def _remove_nested_zones(zones: list[dict]) -> list[dict]:
    shaped = []
    for idx, zone in enumerate(zones):
        geom = _zone_geometry(zone)
        if geom is None or geom.is_empty:
            shaped.append((idx, zone, None, 0.0))
        else:
            shaped.append((idx, zone, geom, float(geom.area)))

    kept: list[tuple[int, dict, Any, float]] = []
    for item in sorted(shaped, key=lambda row: row[3], reverse=True):
        idx, zone, geom, area = item
        if geom is not None and area > 0:
            nested = False
            for _, _, kept_geom, _ in kept:
                if kept_geom is None:
                    continue
                overlap = geom.intersection(kept_geom).area / area
                if geom.within(kept_geom) or overlap >= 0.92:
                    nested = True
                    break
            if nested:
                continue
        kept.append(item)

    return [zone for idx, zone, _, _ in sorted(kept, key=lambda row: row[0])]


# ── SIMULATION ENGINE ────────────────────────────────────────────────────────

def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Returns distance in metres between two lat/lon points."""
    R = 6_371_000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(max(0.0, a)))


async def _simulate_drone_flight(dispatch_data: dict, mgr: ConnectionManager):
    """
    Background task: walks through every waypoint in the dispatched path,
    linearly interpolates lat/lon/alt between them, and broadcasts a
    `live_telemetry` event at ~10 Hz (wall-clock compressed by SPEED_SCALE).

    Waypoints from drone_pathfinder_final.py carry a `timestamp` field
    (seconds from t=0 at dispatch).  We honour those timings so the drone
    moves at the correct speed — just SPEED_SCALE× faster.

    Events emitted:
        live_telemetry  — per-step position update
        drone_arrived   — once when the final waypoint is reached
    """
    drone_id  = str(dispatch_data.get("drone_id", ""))
    alert_id  = dispatch_data.get("alert_id")
    waypoints = dispatch_data.get("waypoints", [])
    n         = len(waypoints)

    if n < 2:
        return

    total_route_time = waypoints[-1].get("timestamp", 0.0)  # seconds (real-time)

    for seg_idx in range(n - 1):
        wp_a = waypoints[seg_idx]
        wp_b = waypoints[seg_idx + 1]

        seg_real_duration = wp_b["timestamp"] - wp_a["timestamp"]  # seconds
        seg_sim_duration  = seg_real_duration / SIMULATION_SPEED_SCALE

        # How many broadcast steps fit in this segment at ~10 Hz?
        steps = max(1, int(seg_sim_duration / MIN_BROADCAST_INTERVAL))
        sleep_per_step = seg_sim_duration / steps

        lat_a, lon_a, alt_a = wp_a["latitude"], wp_a["longitude"], wp_a["altitude"]
        lat_b, lon_b, alt_b = wp_b["latitude"], wp_b["longitude"], wp_b["altitude"]

        for step in range(steps + 1):
            t = step / steps  # 0.0 → 1.0

            lat = lat_a + t * (lat_b - lat_a)
            lon = lon_a + t * (lon_b - lon_a)
            alt = alt_a + t * (alt_b - alt_a)

            # Absolute progress through the whole route
            real_elapsed = wp_a["timestamp"] + t * seg_real_duration
            overall_progress = (real_elapsed / total_route_time) if total_route_time > 0 else 1.0

            await mgr.broadcast("live_telemetry", {
                "drone_id":        drone_id,
                "lat":             round(lat, 7),
                "lon":             round(lon, 7),
                "altitude":        round(alt, 1),
                "speed":           wp_a.get("speed", 13.89),
                "progress":        round(overall_progress, 4),   # 0–1
                "waypoint_index":  seg_idx,
                "waypoint_total":  n,
            })

            if step < steps:  # don't sleep after the last sub-step; outer loop handles timing
                await asyncio.sleep(sleep_per_step)

    # ── Arrival ──────────────────────────────────────────────────────────────
    last = waypoints[-1]
    await mgr.broadcast("drone_arrived", {
        "drone_id": drone_id,
        "alert_id": alert_id,
        "lat":      last["latitude"],
        "lon":      last["longitude"],
    })
    await mgr.broadcast("system_log", {
        "message": f"✅ ARRIVED: Drone {drone_id} reached Alert {alert_id}",
        "level":   "SUCCESS",
    })


# ── 1. REST API: Initial Load ────────────────────────────────────────────────

async def _simulate_drone_flight_v2(dispatch_data: dict, mgr: ConnectionManager):
    """
    Mission-keyed simulator used by the dashboard. The drone only simulates the
    outbound path to the incident; after observation it teleports back to its
    home station and is immediately made available again.
    """
    mission_id = _mission_id(dispatch_data)
    drone_id = str(dispatch_data.get("drone_id", ""))
    alert_id = str(dispatch_data.get("alert_id", ""))
    station_id = dispatch_data.get("station_id")
    waypoints = _normalise_waypoint_times(dispatch_data.get("waypoints", []))
    n = len(waypoints)

    if n < 2:
        return

    home_lat = _as_float(dispatch_data.get("station_lat"), _as_float(waypoints[0].get("latitude")))
    home_lon = _as_float(dispatch_data.get("station_lon"), _as_float(waypoints[0].get("longitude")))
    home_alt = _as_float(waypoints[0].get("altitude"))

    async def walk_leg(points: list[dict], phase: str, status: str) -> dict:
        leg_total_time = _as_float(points[-1].get("timestamp"), 0.0)
        if leg_total_time <= 0:
            leg_total_time = 1.0

        last_leg_progress = 0.0
        last_state: dict = {}

        for seg_idx in range(len(points) - 1):
            wp_a = points[seg_idx]
            wp_b = points[seg_idx + 1]

            seg_real_duration = max(
                _as_float(wp_b.get("timestamp")) - _as_float(wp_a.get("timestamp")),
                0.05,
            )
            seg_sim_duration = seg_real_duration / SIMULATION_SPEED_SCALE
            steps = max(1, int(seg_sim_duration / MIN_BROADCAST_INTERVAL))
            sleep_per_step = seg_sim_duration / steps

            lat_a = _as_float(wp_a.get("latitude"))
            lon_a = _as_float(wp_a.get("longitude"))
            alt_a = _as_float(wp_a.get("altitude"))
            lat_b = _as_float(wp_b.get("latitude"))
            lon_b = _as_float(wp_b.get("longitude"))
            alt_b = _as_float(wp_b.get("altitude"))

            for step in range(steps + 1):
                t = step / steps
                lat = lat_a + t * (lat_b - lat_a)
                lon = lon_a + t * (lon_b - lon_a)
                alt = alt_a + t * (alt_b - alt_a)

                real_elapsed = _as_float(wp_a.get("timestamp")) + t * seg_real_duration
                leg_progress = max(last_leg_progress, min(1.0, real_elapsed / leg_total_time))
                last_leg_progress = leg_progress

                outbound_progress = leg_progress if phase == "outbound" else 1.0
                return_progress = leg_progress if phase == "returning" else 0.0
                speed = _as_float(wp_a.get("speed"), 13.89)

                last_state = fleet_state.update_telemetry(
                    drone_id,
                    lat,
                    lon,
                    altitude=alt,
                    speed=speed,
                    progress=outbound_progress,
                    return_progress=return_progress,
                    mission_id=mission_id,
                    status=status,
                    phase=phase,
                )

                await mgr.broadcast("live_telemetry", {
                    "mission_id": mission_id,
                    "dispatch_id": dispatch_data.get("dispatch_id"),
                    "alert_id": alert_id,
                    "station_id": station_id,
                    "drone_id": drone_id,
                    "lat": round(lat, 7),
                    "lon": round(lon, 7),
                    "altitude": round(alt, 1),
                    "speed": speed,
                    "battery": round(_as_float(last_state.get("battery"), 100.0), 1),
                    "progress": round(outbound_progress, 4),
                    "return_progress": round(return_progress, 4),
                    "phase": phase,
                    "status": status,
                    "waypoint_index": seg_idx,
                    "waypoint_total": len(points),
                })

                if step < steps:
                    await asyncio.sleep(sleep_per_step)

        return last_state

    try:
        await walk_leg(waypoints, "outbound", "dispatched")

        last = waypoints[-1]
        arrived_state = fleet_state.update_telemetry(
            drone_id,
            _as_float(last.get("latitude")),
            _as_float(last.get("longitude")),
            altitude=_as_float(last.get("altitude")),
            speed=0.0,
            progress=1.0,
            return_progress=0.0,
            mission_id=mission_id,
            status="arrived",
            phase="arrived",
        )
        await mgr.broadcast("drone_arrived", {
            "mission_id": mission_id,
            "dispatch_id": dispatch_data.get("dispatch_id"),
            "drone_id": drone_id,
            "alert_id": alert_id,
            "lat": last["latitude"],
            "lon": last["longitude"],
            "battery": round(_as_float(arrived_state.get("battery"), 100.0), 1),
        })
        await mgr.broadcast("system_log", {
            "message": f"ARRIVED: Drone {drone_id} reached Alert {alert_id}",
            "level": "SUCCESS",
        })

        returned_state = fleet_state.update_telemetry(
            drone_id,
            home_lat,
            home_lon,
            frontend_battery=100.0,
            altitude=home_alt,
            speed=0.0,
            progress=1.0,
            return_progress=0.0,
            mission_id=mission_id,
            status="idle",
            phase="idle",
        )
        mark_observed(alert_id)
        update_drone_status(drone_id, "idle")
        release_active_dispatch(dispatch_data.get("dispatch_id"))
        delete_paths_for_incident(alert_id)
        await mgr.broadcast("incident_observed", {
            "mission_id": mission_id,
            "dispatch_id": dispatch_data.get("dispatch_id"),
            "drone_id": drone_id,
            "alert_id": alert_id,
            "station_id": station_id,
            "lat": last["latitude"],
            "lon": last["longitude"],
        })
        await mgr.broadcast("drone_returned", {
            "mission_id": mission_id,
            "dispatch_id": dispatch_data.get("dispatch_id"),
            "drone_id": drone_id,
            "alert_id": alert_id,
            "station_id": station_id,
            "lat": home_lat,
            "lon": home_lon,
            "battery": round(_as_float(returned_state.get("battery"), 100.0), 1),
        })
        await mgr.broadcast("system_log", {
            "message": f"OBSERVED: Alert {alert_id} handled; Drone {drone_id} reset at Station {station_id}",
            "level": "SUCCESS",
        })
    except asyncio.CancelledError:
        await mgr.broadcast("system_log", {
            "message": f"Mission {mission_id} for Drone {drone_id} was superseded",
            "level": "WARNING",
        })
        raise
    finally:
        task = asyncio.current_task()
        if _simulation_tasks_by_mission.get(mission_id) is task:
            _simulation_tasks_by_mission.pop(mission_id, None)
        if _simulation_tasks_by_drone.get(drone_id) is task:
            _simulation_tasks_by_drone.pop(drone_id, None)


@app.get("/api/health")
def get_health():
    """Small health check used by the frontend and startup scripts."""
    return {
        "status": "success",
        "service": "heimdall-api",
        "websocket": "/ws",
        "media_dir": str(MEDIA_DIR),
    }


@app.get("/api/stations")
def get_stations():
    """Frontend calls this ONCE when the map loads to get fixed infrastructure."""
    return {"status": "success", "data": _station_payload()}


@app.get("/api/fleet_state")
def get_initial_fleet_state():
    """Fetch the exact current position of all drones on load."""
    return {"status": "success", "data": fleet_state.get_all_telemetry()}


@app.get("/api/incidents")
def get_incidents():
    """Fetch all actual incidents to populate the frontend table."""
    try:
        return {"status": "success", "data": fetch_all_alerts()}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/paths")
def get_paths():
    """Fetch all active dispatched paths currently saved."""
    try:
        return {"status": "success", "data": fetch_all_paths()}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/restricted_zones")
def get_restricted_zones():
    """Fetch all restricted zones to display on the map."""
    try:
        import yaml
        zone_file = Path(__file__).resolve().parent.parent / "path_finder" / "restricted_zones.yaml"
        if not zone_file.exists():
            return {"status": "success", "data": []}
        with open(zone_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        zones = _remove_nested_zones([zone for zone in data.get("restricted_zones", []) if _zone_is_active(zone)])
        return {"status": "success", "data": zones}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ── 1b. Video Streaming ──────────────────────────────────────────────────────

# Resolve the media/ folder relative to the project root (parent of api/)
MEDIA_DIR = Path(__file__).resolve().parent.parent / "media"

ALLOWED_VIDEO_FILES = {"input1.mp4", "input2.mp4", "input3.mp4", "sample.mp4"}
CHUNK_SIZE = 1024 * 1024  # 1 MB chunks for streaming


@app.get("/api/video/{filename}")
async def stream_video(filename: str, request: Request):
    """
    Streams an MP4 video from the media/ folder with HTTP Range support.
    This lets the browser <video> element seek, buffer, and loop efficiently.
    """
    # Security: only serve whitelisted filenames
    if filename not in ALLOWED_VIDEO_FILES:
        return Response(status_code=404, content="File not found")

    video_path = MEDIA_DIR / filename
    if not video_path.is_file():
        return Response(status_code=404, content="File not found")

    file_size = video_path.stat().st_size
    range_header = request.headers.get("range")

    if range_header:
        # Parse "bytes=START-END"
        range_spec = range_header.replace("bytes=", "")
        parts = range_spec.split("-")
        start = int(parts[0])
        end = int(parts[1]) if parts[1] else min(start + CHUNK_SIZE - 1, file_size - 1)
        end = min(end, file_size - 1)
        length = end - start + 1

        def ranged_file():
            with open(video_path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            ranged_file(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
            },
        )

    # No range — return full file (initial request)
    def full_file():
        with open(video_path, "rb") as f:
            while chunk := f.read(CHUNK_SIZE):
                yield chunk

    return StreamingResponse(
        full_file(),
        media_type="video/mp4",
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
        },
    )


# ── 2. Internal Webhooks (Backend → Server) ──────────────────────────────────

@app.post("/internal/alert")
async def handle_internal_alert(alert_data: Dict[str, Any]):
    await manager.broadcast("new_alert", alert_data)

    msg = (
        f"🚨 NEW INCIDENT: {alert_data.get('incident_type', '').upper()} detected at "
        f"{alert_data.get('latitude', 0):.4f}, {alert_data.get('longitude', 0):.4f}"
    )
    await manager.broadcast("system_log", {"message": msg, "level": "WARNING"})
    return {"status": "broadcasted"}


@app.post("/internal/dispatch")
async def handle_internal_dispatch(dispatch_data: Dict[str, Any]):
    """
    Called by the pathfinder when a drone is assigned.
    1. Immediately broadcasts `drone_dispatched` so the frontend can draw the
       full planned path polyline right away.
    2. Kicks off the background simulation that streams `live_telemetry` as
       the drone 'flies' to its destination.
    """
    mission_id = _mission_id(dispatch_data)
    dispatch_data["mission_id"] = mission_id
    dispatch_data["waypoints"] = _normalise_waypoint_times(dispatch_data.get("waypoints", []))

    await manager.broadcast("drone_dispatched", dispatch_data)

    msg = (
        f"🚁 DISPATCH: Drone {dispatch_data.get('drone_id')} en route to "
        f"Alert {dispatch_data.get('alert_id')} "
        f"(ETA: {dispatch_data.get('eta_seconds')}s)"
    )
    await manager.broadcast("system_log", {"message": msg, "level": "SUCCESS"})

    # ── Fire-and-forget simulation ─────────────────────────────────────────
    # asyncio.create_task() lets the HTTP response return immediately while
    # the simulation runs in the background event loop.
    existing_mission = _simulation_tasks_by_mission.get(mission_id)
    if existing_mission and not existing_mission.done():
        return {"status": "already_running", "mission_id": mission_id}

    drone_id = str(dispatch_data.get("drone_id", ""))
    existing_drone_task = _simulation_tasks_by_drone.get(drone_id)
    if existing_drone_task and not existing_drone_task.done():
        existing_drone_task.cancel()

    task = asyncio.create_task(_simulate_drone_flight_v2(dispatch_data, manager))
    _simulation_tasks_by_mission[mission_id] = task
    _simulation_tasks_by_drone[drone_id] = task

    return {"status": "broadcasted", "mission_id": mission_id}


@app.post("/internal/log")
async def handle_internal_log(log_data: Dict[str, Any]):
    await manager.broadcast("system_log", log_data)
    return {"status": "broadcasted"}


# ── 3. WEBSOCKETS: The Live Firehose ─────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Single WebSocket connection for the React frontend.
    The frontend can still PUSH manual telemetry overrides (e.g. for testing),
    but in normal operation the simulation task does all the pushing.
    """
    await manager.connect(websocket)
    try:
        while True:
            incoming = await websocket.receive_json()

            if incoming.get("event") == "frontend_drone_update":
                data     = incoming.get("data", {})
                drone_id = data.get("drone_id")
                lat      = data.get("lat")
                lon      = data.get("lon")

                updated_state   = fleet_state.update_telemetry(
                    drone_id,
                    lat,
                    lon,
                    altitude=data.get("altitude"),
                    speed=data.get("speed"),
                    progress=data.get("progress"),
                    return_progress=data.get("return_progress"),
                    mission_id=data.get("mission_id"),
                    status=data.get("status"),
                    phase=data.get("phase"),
                )
                data["battery"] = updated_state["battery"]

                await manager.broadcast("live_telemetry", data)

    except WebSocketDisconnect:
        manager.disconnect(websocket)


def run_server():
    print(f"Starting FastAPI & native WebSockets on {API_HOST}:{API_PORT}...")
    uvicorn.run(app, host=API_HOST, port=API_PORT, log_level="error")
