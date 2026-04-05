# ============================================================
# scripts/check_db.py
# Quick CLI utility to inspect ALL tables in the database.
# ============================================================

import sys
import os
import sqlite3

# Allow running from repo root: python scripts/check_db.py
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from config.settings import DB_NAME

def fetch_table_data(table_name: str) -> list[dict]:
    """Helper to fetch all rows from a given table."""
    try:
        with sqlite3.connect(DB_NAME) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"SELECT * FROM {table_name}").fetchall()
            return [dict(r) for r in rows]
    except sqlite3.OperationalError:
        return []

def main() -> None:
    print(f"\n📂 Inspecting Database: {DB_NAME}\n" + "="*60)

    # 1. Check Stations
    stations = fetch_table_data("stations")
    print(f"\n🏢 STATIONS ({len(stations)}):")
    if not stations:
        print("  No stations found.")
    for s in stations:
        print(f"  [Station {s['id']}] Lat: {s['latitude']:.4f}, Lon: {s['longitude']:.4f} | Capacity: {s['capacity']}")

    # 2. Check Drones
    drones = fetch_table_data("drones")
    print(f"\n🚁 DRONES ({len(drones)}):")
    if not drones:
        print("  No drones found.")
    for d in drones:
        status_icon = "🟢" if d['status'] == 'idle' else "🔴"
        print(f"  {status_icon} [Drone {d['id']}] @ Station {d['station_id']} | Status: {d['status'].upper():4s} | Missions: {d['active_missions']}")

    # 3. Check Active Dispatches (Zone Locks)
    dispatches = fetch_table_data("active_dispatches")
    print(f"\n🚀 IN-FLIGHT DISPATCHES ({len(dispatches)}):")
    if not dispatches:
        print("  No drones are currently in flight.")
    for d in dispatches:
        # Trim IDs for cleaner display
        disp_id = d['id'][:8]
        alert_id = d['alert_id'][:8] if d['alert_id'] else "UNKNOWN"
        print(f"  [Dispatch {disp_id}...] Drone {d['drone_id']} -> Alert {alert_id}... | ETA: {d['eta_seconds']}s")

    # 4. Check Alerts Summary
    alerts = fetch_table_data("alerts")
    pending = [a for a in alerts if a['dispatched'] == 0]
    dispatched = [a for a in alerts if a['dispatched'] == 1]
    
    print(f"\n🚨 ALERTS SUMMARY ({len(alerts)} Total):")
    print(f"  ⏳ Pending:    {len(pending)}")
    print(f"  ✅ Dispatched: {len(dispatched)}")
    
    if pending:
        print("\n  -- Top 5 Pending Alerts --")
        # Sort pending by severity (highest first) and show the top 5
        pending.sort(key=lambda x: x['severity'], reverse=True)
        for a in pending[:5]:
            print(f"    [{a['id'][:15]}...] {a['incident_type'].upper():10s} | Sev: {a['severity']:.2f}")
        if len(pending) > 5:
            print(f"    ... and {len(pending) - 5} more.")

    print("\n" + "="*60 + "\n")

if __name__ == "__main__":
    main()