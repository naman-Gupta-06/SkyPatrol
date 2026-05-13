# ============================================================
# dispatch/priority.py
# Alert clustering, drone scoring, and priority dispatch.
# ============================================================

import heapq
import threading
import traceback
import uuid
import requests

from config.settings import (
    BATTERY_PER_KM, HOVER_PER_MIN, RECORDING_TIME_MIN, BATTERY_RESERVE,
    BATTERY_WEIGHT, LOAD_WEIGHT, CLUSTER_THRESHOLD_KM,
    DRONE_SPEED_KMH, ZONE_LOCK_BUFFER_SEC
)
from database.alert_db import (
    fetch_pending_alerts, mark_dispatched, mark_ignored, ignore_pending_alerts_for_zone,
    insert_active_dispatch, is_zone_active,
    fetch_all_stations, fetch_drones_for_station, update_drone_status
)
from dispatch.geo import haversine_km, evaluate_path, save_dispatched_path
from state import fleet_state

_dispatch_lock = threading.Lock()


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _build_live_station_view() -> list[dict]:
    stations = fetch_all_stations()
    for s in stations:
        s["lat"] = s.pop("latitude")
        s["lon"] = s.pop("longitude")
        db_drones = fetch_drones_for_station(s["id"])
        s["drones"] = []
        for d in db_drones:
            telemetry = fleet_state.get_telemetry(d["id"])
            d["battery"] = telemetry["battery"]
            s["drones"].append(d)
    return stations


def cluster_alerts(alerts: list[dict], threshold_km: float = CLUSTER_THRESHOLD_KM) -> list[dict]:
    clusters: list[list[dict]] = []
    for alert in alerts:
        placed = False
        for cluster in clusters:
            if haversine_km(
                alert["latitude"], alert["longitude"],
                cluster[0]["latitude"], cluster[0]["longitude"]
            ) < threshold_km:
                cluster.append(alert)
                placed = True
                break
        if not placed:
            clusters.append([alert])

    merged = []
    for cluster in clusters:
        best = max(cluster, key=lambda a: a["severity"])
        rep = best.copy()
        rep["cluster_size"] = len(cluster)
        rep["avg_severity"] = sum(a["severity"] for a in cluster) / len(cluster)
        merged.append(rep)
    return merged


def _required_battery(distance_km: float) -> float:
    return (
        (distance_km * BATTERY_PER_KM)
        + (RECORDING_TIME_MIN * HOVER_PER_MIN)
        + BATTERY_RESERVE
    )


def select_drone_from_station(station: dict, distance_km: float) -> dict | None:
    best_drone = None
    best_score = float("inf")
    for drone in station["drones"]:
        if drone["status"] != "idle" or drone["battery"] < _required_battery(distance_km):
            continue
        score = (BATTERY_WEIGHT * (100 - drone["battery"])) + (LOAD_WEIGHT * drone["load_count"])
        if score < best_score:
            best_score = score
            best_drone = drone
    return best_drone


def _mark_station_drone_dispatched(stations: list[dict], drone_id: int) -> None:
    """
    Keep the in-memory station snapshot aligned with DB updates so one
    dispatch cycle cannot reuse the same drone for multiple alerts.
    """
    for station in stations:
        for drone in station["drones"]:
            if drone["id"] == drone_id:
                drone["status"] = "dispatched"
                drone["load_count"] += 1
                return


def _execute_dispatch(station, drone, distance, alert, waypoints, incident_id):
    """
    Lock the zone, persist the minimum path to drone_paths.db,
    and broadcast the dispatch event to the frontend.

    save_dispatched_path() is called HERE — only when a drone is confirmed.
    This guarantees exactly 1 DB row per successfully dispatched alert.
    """
    eta = (
        (distance / DRONE_SPEED_KMH) * 3600
        + RECORDING_TIME_MIN * 60
        + ZONE_LOCK_BUFFER_SEC
    )
    did = uuid.uuid4().hex

    # Lock the geographic zone in alerts.db
    insert_active_dispatch(
        did, alert["id"], drone["id"], station["id"],
        alert["latitude"], alert["longitude"], eta
    )
    update_drone_status(drone["id"], "dispatched")

    # ── Save minimum path to drone_paths.db (exactly once per dispatch) ───────
    save_dispatched_path(
        station_lat=station["lat"],
        station_lon=station["lon"],
        incident_lat=alert["latitude"],
        incident_lon=alert["longitude"],
        incident_id=incident_id,
        drone_id=str(drone["id"]),
        waypoints=waypoints,
        estimated_time=round(distance / DRONE_SPEED_KMH * 3600, 1),
    )

    result = {
        "dispatch_id":   did,
        "alert_id":      alert["id"],
        "incident_type": alert["incident_type"],
        "severity":      alert["severity"],
        "station_id":    station["id"],
        "station_lat":   station["lat"],
        "station_lon":   station["lon"],
        "drone_id":      drone["id"],
        "distance_km":   round(distance, 3),
        "eta_seconds":   round(eta, 1),
        "waypoints":     waypoints,
    }

    try:
        requests.post("http://127.0.0.1:5001/internal/dispatch", json=result, timeout=2.0)
    except requests.exceptions.RequestException:
        pass

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Core dispatch logic
# ─────────────────────────────────────────────────────────────────────────────

def dispatch_single(stations: list[dict], alert: dict) -> dict | None:
    ilat, ilon = alert["latitude"], alert["longitude"]

    if is_zone_active(ilat, ilon, threshold_km=CLUSTER_THRESHOLD_KM):
        mark_ignored(alert["id"])
        return None

    # Use the alert id as the persisted incident id so paths can be removed as
    # soon as that exact incident is observed.
    incident_id = alert["id"]

    # ── Step 1: Evaluate A* path from EVERY station → incident (in memory) ────
    #
    # evaluate_path() always returns a valid dict — never None.
    # When A* fails it returns a 2-point straight-line path so we always
    # have meaningful waypoints.
    # Nothing is written to drone_paths.db at this stage.
    #
    station_routes = []
    for s in stations:
        path_result = evaluate_path(s["lat"], s["lon"], ilat, ilon)
        if path_result.get("blocked") or not path_result.get("waypoints"):
            print(f"   ⛔ Station {s['id']} skipped - path crosses hard restricted airspace")
            continue
        dist = path_result["total_distance"]
        wps  = path_result["waypoints"]
        kind = "restricted-aware" if path_result.get("restricted_aware") else "haversine" if path_result.get("fallback") else "A*"
        print(f"   📡 Station {s['id']} → incident  dist={dist:.3f} km  [{kind}]")

        station_routes.append({
            "station":     s,
            "distance_km": dist,
            "waypoints":   wps,
        })

    # ── Step 2: Sort by distance — nearest station first ─────────────────────
    station_routes.sort(key=lambda r: r["distance_km"])

    if not station_routes:
        print(f"   ❌ No eligible station routes for alert {alert['id']}")
        return None

    min_route = station_routes[0]
    print(
        f"   ⭐ Minimum path → station={min_route['station']['id']}  "
        f"dist={min_route['distance_km']:.3f} km  "
        f"waypoints={len(min_route['waypoints'])}"
    )

    # ── Step 3: Try stations in order — dispatch from first available drone ───
    #
    # save_dispatched_path() is called inside _execute_dispatch() ONLY when
    # a drone is confirmed → exactly 1 DB row written per successful dispatch.
    # If no drone is available, NOTHING is written to drone_paths.db.
    #
    for route in station_routes:
        station  = route["station"]
        distance = route["distance_km"]
        wps      = route["waypoints"]

        drone = select_drone_from_station(station, distance)
        if drone:
            print(
                f"   ✅ Dispatching drone {drone['id']} from station {station['id']}"
                f"  (dist={distance:.3f} km, battery={drone['battery']:.1f}%)"
            )
            return _execute_dispatch(station, drone, distance, alert, wps, incident_id)
        else:
            print(f"   ⏭️  Station {station['id']} skipped — no idle drone with sufficient battery")

    print(f"   ❌ No drone available for alert {alert['id']}")
    return None


def priority_dispatch(stations: list[dict], alerts: list[dict]) -> list[dict]:
    alerts = cluster_alerts(alerts)
    heap   = [(-a["severity"], a["id"], a) for a in alerts]
    heapq.heapify(heap)

    results = []
    while heap:
        _, _, alert = heapq.heappop(heap)
        try:
            result = dispatch_single(stations, alert)
            if result:
                results.append(result)
                _mark_station_drone_dispatched(stations, result["drone_id"])
                mark_dispatched(alert["id"])
                ignored_count = ignore_pending_alerts_for_zone(
                    alert["latitude"],
                    alert["longitude"],
                    threshold_km=CLUSTER_THRESHOLD_KM,
                    exclude_alert_id=alert["id"],
                )
                if ignored_count:
                    print(f"   ⏭️  Ignored {ignored_count} duplicate queued alert(s) for active location")
        except Exception as exc:
            print(f"❌ Dispatch failed for alert {alert['id']}: {exc}")
            traceback.print_exc()
    return results


def run_priority_dispatch() -> None:
    _dispatch_lock.acquire()
    try:
        alerts = fetch_pending_alerts()
        if not alerts:
            return
        stations = _build_live_station_view()
        priority_dispatch(stations, alerts)
    finally:
        _dispatch_lock.release()


def trigger_priority_dispatch_async(reason: str = "alert") -> None:
    thread = threading.Thread(
        target=run_priority_dispatch,
        daemon=True,
        name=f"dispatch-trigger-{reason}",
    )
    thread.start()
