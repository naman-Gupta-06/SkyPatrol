# ============================================================
# state/fleet_state.py
# High-velocity in-memory storage + Battery Simulation.
# ============================================================

import threading
import time
from dispatch.geo import haversine_km

_telemetry_lock = threading.Lock()
_drone_telemetry = {}


def _drone_key(drone_id) -> str:
    return str(drone_id)


def _as_float(value, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback

def update_telemetry(
    drone_id: int | str,
    lat: float,
    lon: float,
    frontend_battery: float = None,
    altitude: float | None = None,
    speed: float | None = None,
    progress: float | None = None,
    mission_id: str | None = None,
    status: str | None = None,
    phase: str | None = None,
    return_progress: float | None = None,
) -> dict:
    """
    Updates location. If the drone moved, automatically drain 10% battery per km.
    """
    with _telemetry_lock:
        key = _drone_key(drone_id)
        lat = _as_float(lat)
        lon = _as_float(lon)
        old_data = _drone_telemetry.get(key)
        current_battery = old_data["battery"] if old_data else 100.0

        # If frontend didn't pass a specific battery, we simulate the drain based on distance moved
        if old_data and frontend_battery is None:
            dist_km = haversine_km(old_data["lat"], old_data["lon"], lat, lon)
            if dist_km > 0.0001:  # Only drain if it actually moved significantly
                drain = dist_km * 10.0  # 10% per 1 kilometer
                current_battery = max(0.0, current_battery - drain)
        elif frontend_battery is not None:
            current_battery = frontend_battery

        next_data = {
            "lat": lat,
            "lon": lon,
            "battery": current_battery,
            "last_updated": time.time()
        }
        if altitude is not None:
            next_data["altitude"] = _as_float(altitude)
        if speed is not None:
            next_data["speed"] = _as_float(speed)
        if progress is not None:
            same_mission = old_data and old_data.get("mission_id") == mission_id
            previous_progress = old_data.get("progress", 0.0) if same_mission else 0.0
            next_data["progress"] = max(_as_float(previous_progress), _as_float(progress))
        if return_progress is not None:
            same_mission = old_data and old_data.get("mission_id") == mission_id
            previous_return_progress = old_data.get("return_progress", 0.0) if same_mission else 0.0
            next_data["return_progress"] = max(_as_float(previous_return_progress), _as_float(return_progress))
        if mission_id is not None:
            next_data["mission_id"] = mission_id
        if status is not None:
            next_data["status"] = status
        if phase is not None:
            next_data["phase"] = phase

        _drone_telemetry[key] = next_data
        return _drone_telemetry[key].copy()

def charge_idle_drone(drone_id: int | str, charge_amount: float = 1.0) -> None:
    """Safely increments the battery of an idle drone up to 100%."""
    with _telemetry_lock:
        key = _drone_key(drone_id)
        if key in _drone_telemetry:
            current = _drone_telemetry[key]["battery"]
            _drone_telemetry[key]["battery"] = min(100.0, current + charge_amount)

def get_telemetry(drone_id: int | str, default_battery: float = 100.0) -> dict:
    with _telemetry_lock:
        data = _drone_telemetry.get(_drone_key(drone_id))
        if data:
            return data.copy()
        return {
            "lat": 0.0,
            "lon": 0.0,
            "battery": default_battery,
            "speed": 0.0,
            "altitude": 0.0,
            "progress": 0.0,
            "return_progress": 0.0,
            "status": "idle",
            "phase": "idle",
        }

def get_all_telemetry() -> dict:
    with _telemetry_lock:
        return {key: value.copy() for key, value in _drone_telemetry.items()}
