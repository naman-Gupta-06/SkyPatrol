# ============================================================
# main.py
# Application entry point.
# ============================================================

import threading
import time
import requests

from config.settings import DISPATCH_LOOP_INTERVAL_SEC
from database.alert_db import init_db, cleanup_worker, insert_station, insert_drone, fetch_all_stations, clear_all_data, fetch_drones_for_station, fetch_all_alerts, count_alerts
from database.path_db import init_path_db, clear_path_db
from state import fleet_state
from detection.detector import run_detection
from dispatch.priority import run_priority_dispatch
from api.server import run_server

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
    insert_station(1, 18.53467342230246, 73.8563574153564, 2)
    insert_drone(1, 1)
    insert_drone(2, 1)
    fleet_state.update_telemetry(1, 18.53467342230246, 73.8563574153564, 100.0)
    fleet_state.update_telemetry(2, 18.53467342230246, 73.8563574153564, 100.0)


    # 18.53662250705596, 73.8952101768864
    # Station 2
    insert_station(2, 18.53662250705596, 73.8952101768864, 1)
    insert_drone(3, 2)
    fleet_state.update_telemetry(3, 18.53662250705596, 73.8952101768864, 100.0)

def _priority_loop() -> None:
    """Background thread: run dispatch every DISPATCH_LOOP_INTERVAL_SEC seconds."""
    while True:
        run_priority_dispatch()
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


def _alert_db_watcher() -> None:
    """
    Daemon thread: polls alerts.db every 2 seconds.
    When a new alert row is detected:
      1. Prints a detailed log to the console (visible when running main.py)
      2. Broadcasts it to the FastAPI server via /internal/alert
         → fans out to all WebSocket clients → System Logs in frontend update.
    """
    _INTERNAL_URL = "http://127.0.0.1:5001/internal/alert"
    last_seen_count = count_alerts()   # warm start — don't re-announce existing rows
    print(f"👁️  Alert-DB watcher started  (baseline: {last_seen_count} existing alerts)")

    while True:
        time.sleep(2)
        try:
            current_count = count_alerts()
            if current_count > last_seen_count:
                delta = current_count - last_seen_count
                all_alerts = fetch_all_alerts()
                new_alerts = all_alerts[-delta:]

                print(f"\n{'='*60}")
                print(f"🗄️  ALERTS.DB UPDATED  (+{delta} new row{'s' if delta > 1 else ''})")
                print(f"{'='*60}")

                for alert in new_alerts:
                    itype = (alert.get("incident_type") or "UNKNOWN").upper()
                    cam   = alert.get("camera_id",  "??")
                    lat   = alert.get("latitude",   0.0)
                    lon   = alert.get("longitude",  0.0)
                    conf  = alert.get("confidence", None)
                    ts    = alert.get("timestamp",  "")
                    conf_str = f"{conf:.2f}" if isinstance(conf, float) else "N/A"

                    print(f"  🚨 [{ts}] {itype}")
                    print(f"     Camera : {cam}")
                    print(f"     Coords : ({lat:.5f}, {lon:.5f})")
                    print(f"     Confidence: {conf_str}")
                    print()

                    try:
                        requests.post(_INTERNAL_URL, json=alert, timeout=2)
                    except Exception:
                        pass  # Server not up yet — will catch next cycle

                last_seen_count = current_count
        except Exception:
            pass  # DB not ready yet — will catch next cycle

def main() -> None:
    # 1. Initialise the database schemas & seed initial infrastructure.
    init_db()        # alerts.db  → stations / drones / alerts / active_dispatches
    init_path_db()   # drone_paths.db → paths

    # Clear previous dynamic testing state
    clear_all_data()
    clear_path_db()

    _seed_database()

    # 2. Start the DB cleanup daemon.
    threading.Thread(target=cleanup_worker, daemon=True, name="db-cleanup").start()

    # 3. Start the autonomous battery charger.
    threading.Thread(target=_battery_charging_worker, daemon=True, name="battery-charger").start()

    # 4. Start the alerts.db watcher — pushes new alerts to WS clients.
    threading.Thread(target=_alert_db_watcher, daemon=True, name="alert-watcher").start()

    # 5. Start one detection thread per camera.
    for cam in CAMERAS:
        threading.Thread(
            target=run_detection,
            args=(cam["source"], cam["id"], cam["lat"], cam["lon"]),
            daemon=True,
            name=f"detect-{cam['id']}",
        ).start()

    # 5. Start the priority dispatch loop.
    threading.Thread(target=_priority_loop, daemon=True, name="dispatch-loop").start()

    # 6. Start the FastAPI Server (This blocks the main thread)
    run_server()

if __name__ == "__main__":
    main()
