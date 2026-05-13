# ============================================================
# dispatch/geo.py
# Geographic helper utilities & Pathfinder Integration.
# ============================================================

from __future__ import annotations

import math
import os
import threading
import warnings as _warnings
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Optional

import yaml
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import transform
from pyproj import Transformer

DRONE_SPEED_KMH = 50.0   # must match drone_pathfinder_final.py
_ZONE_FILE = Path(__file__).resolve().parent.parent / "path_finder" / "restricted_zones.yaml"
_ROUTE_BUFFER_M = 80.0
_DETOUR_MARGIN_M = 180.0
_MAX_DETOUR_PASSES = 10
_FULL_ASTAR_ENABLED = os.getenv("HEIMDALL_ENABLE_FULL_ASTAR", "0").lower() in {"1", "true", "yes"}
_TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True)
_TO_WGS84 = Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True)

# ---------------------------------------------------------------------------
# 1. HAVERSINE (fast straight-line distance)
# ---------------------------------------------------------------------------

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi       = math.radians(lat2 - lat1)
    dlambda    = math.radians(lon2 - lon1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2)
    return R * (2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)))


# ---------------------------------------------------------------------------
# 2. STRAIGHT-LINE FALLBACK PATH
#
# Used when A* pathfinder is unavailable or fails for a coordinate pair.
# Returns the same dict schema as find_path() — 2 waypoints, haversine dist.
# ---------------------------------------------------------------------------

def _waypoints_from_route_xy(route_xy: list[tuple[float, float]]) -> tuple[list[dict], float, float]:
    speed_ms = DRONE_SPEED_KMH * (1000 / 3600)
    waypoints: list[dict] = []
    elapsed = 0.0
    total_m = 0.0

    for idx, (x, y) in enumerate(route_xy):
        lon, lat = _TO_WGS84.transform(x, y)
        if idx > 0:
            px, py = route_xy[idx - 1]
            segment_m = math.hypot(x - px, y - py)
            total_m += segment_m
            elapsed += segment_m / speed_ms
        waypoints.append({
            "latitude": round(lat, 6),
            "longitude": round(lon, 6),
            "altitude": 50.0,
            "timestamp": round(elapsed, 1),
            "speed": round(speed_ms, 2),
        })

    return waypoints, round(total_m / 1000, 3), round(elapsed, 1)


def _straight_line_path(
    station_lat: float, station_lon: float,
    incident_lat: float, incident_lon: float,
) -> dict:
    """
    Build a minimal 2-waypoint straight-line path between station and incident.
    This is the fallback when the A* pathfinder cannot compute a route.
    The schema matches PunePathfinder.find_path() output exactly.
    """
    dist_km  = haversine_km(station_lat, station_lon, incident_lat, incident_lon)
    speed_ms = DRONE_SPEED_KMH * (1000 / 3600)   # m/s
    travel_s = round((dist_km * 1000) / speed_ms, 1)

    waypoints = [
        {
            "latitude":  round(station_lat, 6),
            "longitude": round(station_lon, 6),
            "altitude":  50.0,
            "timestamp": 0.0,
            "speed":     round(speed_ms, 2),
        },
        {
            "latitude":  round(incident_lat, 6),
            "longitude": round(incident_lon, 6),
            "altitude":  50.0,
            "timestamp": travel_s,
            "speed":     round(speed_ms, 2),
        },
    ]

    return {
        "id":             None,           # no DB id yet — caller handles storage
        "total_distance": round(dist_km, 3),
        "estimated_time": travel_s,
        "waypoints":      waypoints,
        "fallback":       True,           # flag so caller knows it's not A*
    }


def _restricted_aware_path(
    station_lat: float,
    station_lon: float,
    incident_lat: float,
    incident_lon: float,
) -> dict:
    route_xy = _build_detour_route(station_lat, station_lon, incident_lat, incident_lon)
    if route_xy is None:
        return _blocked_path("restricted-zone planner could not build a legal route")

    waypoints, dist_km, travel_s = _waypoints_from_route_xy(route_xy)
    if _path_crosses_restricted_zone(waypoints):
        return _blocked_path("restricted-zone planner route crosses restricted airspace")

    return {
        "id": None,
        "total_distance": dist_km,
        "estimated_time": travel_s,
        "waypoints": waypoints,
        "fallback": True,
        "restricted_aware": True,
    }


def _blocked_path(reason: str) -> dict:
    return {
        "id": None,
        "total_distance": math.inf,
        "estimated_time": math.inf,
        "waypoints": [],
        "fallback": False,
        "blocked": True,
        "reason": reason,
    }


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


def _zone_to_wgs84_geometry(zone: dict):
    shape = zone.get("shape", "circle")
    if shape == "circle" and zone.get("center") and zone.get("radius_m"):
        lat, lon = zone["center"]
        radius_deg = float(zone["radius_m"]) / 111_000.0
        return Point(float(lon), float(lat)).buffer(radius_deg, resolution=40)
    if shape == "polygon" and zone.get("polygon"):
        poly = Polygon([(float(lon), float(lat)) for lat, lon in zone["polygon"]])
        return poly if poly.is_valid else poly.buffer(0)
    return None


@lru_cache(maxsize=1)
def _restricted_zone_geometries() -> tuple:
    if not _ZONE_FILE.exists():
        return ()
    data = yaml.safe_load(_ZONE_FILE.read_text(encoding="utf-8")) or {}
    geometries = []
    for zone in data.get("restricted_zones", []):
        if not _zone_is_active(zone):
            continue
        geom = _zone_to_wgs84_geometry(zone)
        if geom is not None and not geom.is_empty:
            geometries.append(geom)
    return tuple(geometries)


@lru_cache(maxsize=1)
def _restricted_zone_metric_geometries() -> tuple:
    return tuple(
        transform(lambda x, y, z=None: _TO_UTM.transform(x, y), geom).buffer(_ROUTE_BUFFER_M)
        for geom in _restricted_zone_geometries()
        if geom is not None and not geom.is_empty
    )


def _path_crosses_restricted_zone(waypoints: list[dict]) -> bool:
    coords = [
        _TO_UTM.transform(float(wp["longitude"]), float(wp["latitude"]))
        for wp in waypoints
        if "latitude" in wp and "longitude" in wp
    ]
    if len(coords) < 2:
        return False
    line = LineString(coords)
    return any(line.intersects(zone) for zone in _restricted_zone_metric_geometries())


def _segment_hit(segment: LineString):
    for zone in _restricted_zone_metric_geometries():
        if segment.intersects(zone):
            return zone
    return None


def _zone_reach_m(zone) -> float:
    cx, cy = zone.centroid.coords[0]
    minx, miny, maxx, maxy = zone.bounds
    return max(
        math.hypot(x - cx, y - cy)
        for x in (minx, maxx)
        for y in (miny, maxy)
    )


def _route_is_clear(route_xy: list[tuple[float, float]]) -> bool:
    return all(
        _segment_hit(LineString([route_xy[idx], route_xy[idx + 1]])) is None
        for idx in range(len(route_xy) - 1)
    )


def _route_avoids_zone(route_xy: list[tuple[float, float]], zone) -> bool:
    return all(
        not LineString([route_xy[idx], route_xy[idx + 1]]).intersects(zone)
        for idx in range(len(route_xy) - 1)
    )


def _detour_candidates(
    start_xy: tuple[float, float],
    end_xy: tuple[float, float],
    zone,
) -> list[list[tuple[float, float]]]:
    sx, sy = start_xy
    ex, ey = end_xy
    dx = ex - sx
    dy = ey - sy
    length = math.hypot(dx, dy)
    if length < 1:
        return []

    ux = dx / length
    uy = dy / length
    px = -uy
    py = ux
    cx, cy = zone.centroid.coords[0]
    reach = _zone_reach_m(zone)

    candidates: list[list[tuple[float, float]]] = []
    for extra in (_DETOUR_MARGIN_M, 320.0, 520.0, 820.0, 1300.0):
        offset = reach + extra
        forward = reach + extra * 0.45
        for side in (1.0, -1.0):
            side_x = px * side
            side_y = py * side
            candidates.append([
                start_xy,
                (cx - ux * forward + side_x * offset, cy - uy * forward + side_y * offset),
                (cx + ux * forward + side_x * offset, cy + uy * forward + side_y * offset),
                end_xy,
            ])
    return candidates


def _choose_detour(
    start_xy: tuple[float, float],
    end_xy: tuple[float, float],
    zone,
) -> list[tuple[float, float]] | None:
    clear_candidates = []
    for candidate in _detour_candidates(start_xy, end_xy, zone):
        if _route_avoids_zone(candidate, zone):
            distance = sum(
                math.hypot(candidate[idx + 1][0] - candidate[idx][0], candidate[idx + 1][1] - candidate[idx][1])
                for idx in range(len(candidate) - 1)
            )
            if not _route_is_clear(candidate):
                distance *= 1.35
            clear_candidates.append((distance, candidate))
    if not clear_candidates:
        return None
    clear_candidates.sort(key=lambda item: item[0])
    return clear_candidates[0][1]


def _build_detour_route(
    station_lat: float,
    station_lon: float,
    incident_lat: float,
    incident_lon: float,
) -> list[tuple[float, float]] | None:
    start_xy = _TO_UTM.transform(float(station_lon), float(station_lat))
    end_xy = _TO_UTM.transform(float(incident_lon), float(incident_lat))
    zones = _restricted_zone_metric_geometries()

    start_pt = Point(start_xy)
    end_pt = Point(end_xy)
    if any(zone.contains(start_pt) or zone.contains(end_pt) for zone in zones):
        return None

    route = [start_xy, end_xy]
    for _ in range(_MAX_DETOUR_PASSES):
        changed = False
        for idx in range(len(route) - 1):
            segment = LineString([route[idx], route[idx + 1]])
            zone = _segment_hit(segment)
            if zone is None:
                continue

            detour = _choose_detour(route[idx], route[idx + 1], zone)
            if detour is None:
                return None
            route = route[:idx] + detour + route[idx + 2:]
            changed = True
            break
        if not changed:
            return route
    return route if _route_is_clear(route) else None


# ---------------------------------------------------------------------------
# 3. PATHFINDER SINGLETON
# ---------------------------------------------------------------------------

_pathfinder_instance: Optional[object] = None
_pathfinder_lock = threading.Lock()


def _get_pathfinder():
    global _pathfinder_instance
    if _pathfinder_instance is not None:
        return _pathfinder_instance

    with _pathfinder_lock:
        if _pathfinder_instance is not None:
            return _pathfinder_instance
        try:
            from path_finder.drone_pathfinder_final import PunePathfinder
            _pathfinder_instance = PunePathfinder()
            print("PunePathfinder initialised (shared singleton)")
        except Exception as exc:
            _warnings.warn(f"PunePathfinder unavailable: {exc}")
            _pathfinder_instance = None
    return _pathfinder_instance


# ---------------------------------------------------------------------------
# 4. EVALUATE A SINGLE STATION → INCIDENT PATH  (NO DB write)
#
# Always returns a valid dict — never None.
# When A* fails, returns a 2-point straight-line path so the caller always
# has real waypoints and a meaningful distance to work with.
# ---------------------------------------------------------------------------

def evaluate_path(
    station_lat: float, station_lon: float,
    incident_lat: float, incident_lon: float,
) -> dict:
    """
    Run A* from one station to the incident location.

    ● Does NOT write anything to drone_paths.db (save_to_db=False).
    ● ALWAYS returns a valid result dict — never None.
      - If A* succeeds: returns full 3-D waypoints + real distance.
      - If A* fails:    returns a 2-point straight-line fallback.
    ● Return schema:
        {
            "id":             str | None,   # None for fallback paths
            "total_distance": float,        # km
            "estimated_time": float,        # seconds
            "waypoints":      list[dict],   # at least 2 waypoints
            "fallback":       bool,         # True if A* was not used
        }
    """
    if not _FULL_ASTAR_ENABLED:
        return _restricted_aware_path(station_lat, station_lon, incident_lat, incident_lon)

    pathfinder = _get_pathfinder()
    if pathfinder is None:
        return _restricted_aware_path(station_lat, station_lon, incident_lat, incident_lon)

    try:
        result = pathfinder.find_path(
            start=(station_lat, station_lon),
            end=(incident_lat, incident_lon),
            save_to_db=False,
        )
        waypoints = result.get("waypoints", []) if result else []
        if result and not result.get("error") and len(waypoints) >= 2:
            start_drift_km = haversine_km(
                station_lat,
                station_lon,
                waypoints[0]["latitude"],
                waypoints[0]["longitude"],
            )
            end_drift_km = haversine_km(
                incident_lat,
                incident_lon,
                waypoints[-1]["latitude"],
                waypoints[-1]["longitude"],
            )
            if start_drift_km > 0.3 or end_drift_km > 0.3:
                raise ValueError(
                    f"pathfinder endpoint drift start={start_drift_km:.3f}km end={end_drift_km:.3f}km"
                )
            if _path_crosses_restricted_zone(waypoints):
                return _restricted_aware_path(station_lat, station_lon, incident_lat, incident_lon)
            result["fallback"] = False
            return result
    except Exception as exc:
        _warnings.warn(f"Pathfinder failed; using restricted-zone planner: {exc}")

    return _restricted_aware_path(station_lat, station_lon, incident_lat, incident_lon)


# ---------------------------------------------------------------------------
# 5. SAVE THE WINNING PATH TO drone_paths.db
#
# Called exactly ONCE per successful dispatch — NOT before.
# This guarantees: 1 row per dispatched alert, no re-dispatch duplicates.
# ---------------------------------------------------------------------------

def save_dispatched_path(
    station_lat:   float,
    station_lon:   float,
    incident_lat:  float,
    incident_lon:  float,
    incident_id:   str,
    drone_id:      str,
    waypoints:     list,
    estimated_time: float,
) -> None:
    """
    Persist the dispatched minimum path to drone_paths.db.

    Rules enforced here:
      - Called only when a drone is confirmed dispatched.
      - Checks for an existing row with the same incident_id to prevent
        duplicates if the dispatch loop re-processes a pending alert.
    """
    import uuid
    from datetime import datetime
    from database.path_db import insert_path, path_exists_for_incident

    # Idempotency guard: only one row per incident
    if path_exists_for_incident(incident_id):
        print(f"   ℹ️  Path already stored for incident {incident_id} — skipping duplicate insert")
        return

    insert_path(
        path_id=uuid.uuid4().hex[:8],
        drone_id=drone_id,
        station_lat=station_lat,
        station_lon=station_lon,
        incident_lat=incident_lat,
        incident_lon=incident_lon,
        waypoints=waypoints,
        estimated_time=estimated_time,
        created_at=datetime.now().isoformat(),
        incident_id=incident_id,
        is_minimum=True,
    )
