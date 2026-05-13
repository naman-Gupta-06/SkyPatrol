# ============================================================
# main.py
# Application entry point.
# ============================================================

import threading
import time
import traceback
import urllib.request
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from config.settings import DISPATCH_LOOP_INTERVAL_SEC
from database.alert_db import init_db, cleanup_worker, insert_station, insert_drone, fetch_all_stations, clear_all_data, fetch_drones_for_station
from database.path_db import init_path_db, clear_all_paths
from state import fleet_state
from detection.detector import run_detection
from dispatch.priority import run_priority_dispatch
from api.server import API_PORT, run_server

# ── Camera definitions ────────────────────────────────────────────────────────

CAMERAS = [
    {"id": "cam_1", "source": "media/input1.mp4", "lat": 18.5391667, "lon": 73.8632778},
    {"id": "cam_2", "source": "media/input2.mp4", "lat": 18.4953812, "lon": 73.9040143},
    {"id": "cam_3", "source": "media/input3.mp4", "lat": 18.5421412, "lon": 73.8110657},
]

# ── Bootstrap ─────────────────────────────────────────────────────────────────

def _seed_database():
    """Upsert stations and drones — runs every startup so coordinate changes take effect."""
    print("🌱 Seeding database with stations and drones...")

    # 18.53467342230246, 73.8563574153564
    # Station 1
    insert_station(1, 18.5346, 73.8655, 2)
    insert_drone(1, 1)
    insert_drone(2, 1)
    fleet_state.update_telemetry(1, 18.5346, 73.8655, 100.0)
    fleet_state.update_telemetry(2, 18.5346, 73.8655, 100.0)


    # Station 2
    insert_station(2, 18.5208, 73.9285, 2)
    insert_drone(3, 2)
    insert_drone(4, 2)
    fleet_state.update_telemetry(3, 18.5208, 73.9285, 100.0)
    fleet_state.update_telemetry(4, 18.5208, 73.9285, 100.0)

def _priority_loop() -> None:
    """Background thread: run dispatch every DISPATCH_LOOP_INTERVAL_SEC seconds."""
    while True:
        try:
            run_priority_dispatch()
        except Exception as exc:
            print(f"❌ Dispatch loop crashed: {exc}")
            traceback.print_exc()
        time.sleep(DISPATCH_LOOP_INTERVAL_SEC)

def _battery_charging_worker() -> None:
    """Daemon thread: Slowly charges drones sitting idle at their stations."""
    while True:
        stations = fetch_all_stations()
        for s in stations:
            drones = fetch_drones_for_station(s["id"])
            for d in drones:
                # If the drone is sitting at the station, charge it by 1% every 5 seconds
                if d["status"] == "idle":
                    fleet_state.charge_idle_drone(d["id"], charge_amount=1.0)
        time.sleep(5)

def _wait_for_api(timeout_sec: float = 15.0) -> None:
    """Wait until FastAPI is accepting requests before detectors post events."""
    deadline = time.time() + timeout_sec
    url = f"http://127.0.0.1:{API_PORT}/api/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1):
                print("Backend API is ready.")
                return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError(f"Backend API did not become ready at {url}")

def main() -> None:
    # 1. Initialise the database schemas & seed initial infrastructure.
    init_db()        # alerts.db  → stations / drones / alerts / active_dispatches
    init_path_db()   # drone_paths.db → paths

    # Clear previous dynamic testing state
    clear_all_data()
    clear_all_paths()

    _seed_database()

    # 2. Start FastAPI first so detector/dispatch webhooks are not lost.
    threading.Thread(target=run_server, daemon=True, name="api-server").start()
    _wait_for_api()

    # 3. Start the DB cleanup daemon.
    threading.Thread(target=cleanup_worker, daemon=True, name="db-cleanup").start()

    # 4. Start the autonomous battery charger.
    threading.Thread(target=_battery_charging_worker, daemon=True, name="battery-charger").start()

    # 5. Start one detection thread per camera.
    detector_threads = []
    for cam in CAMERAS:
        thread = threading.Thread(
            target=run_detection,
            args=(cam["source"], cam["id"], cam["lat"], cam["lon"]),
            daemon=True,
            name=f"detect-{cam['id']}",
        )
        thread.start()
        detector_threads.append(thread.name)
    print(f"Started detector threads: {', '.join(detector_threads)}")

    # 6. Start the priority dispatch loop.
    threading.Thread(target=_priority_loop, daemon=True, name="dispatch-loop").start()

    # Keep the backend process alive while worker threads do the work.
    while True:
        time.sleep(3600)

if __name__ == "__main__":
    main()
