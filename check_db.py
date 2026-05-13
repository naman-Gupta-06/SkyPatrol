"""
check_db.py
===========
Run this from the project root to inspect both databases:

    python3 check_db.py

No project dependencies required — pure sqlite3 only.
"""

import sqlite3
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))

ALERTS_DB = os.path.join(BASE, "database", "alerts.db")
PATHS_DB  = os.path.join(BASE, "database", "drone_paths.db")

SEP  = "─" * 70
SEP2 = "═" * 70


# ── helpers ───────────────────────────────────────────────────────────────────

def check_db(db_path: str, label: str):
    print(f"\n{SEP2}")
    print(f"  DATABASE: {label}")
    print(f"  FILE    : {db_path}")
    print(SEP2)

    if not os.path.exists(db_path):
        print("  ❌  File does not exist yet.\n")
        return

    size_kb = os.path.getsize(db_path) / 1024
    print(f"  ✅  Exists  ({size_kb:.1f} KB)\n")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # list all tables
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()]

    if not tables:
        print("  ⚠️  No tables found.\n")
        conn.close()
        return

    for table in tables:
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        print(f"{SEP}")
        print(f"  TABLE: {table}   ({len(rows)} row{'s' if len(rows) != 1 else ''})")
        print(SEP)

        if not rows:
            print("  (empty)\n")
            continue

        # column names
        cols = rows[0].keys()
        col_w = {c: max(len(c), 10) for c in cols}

        # measure column widths from data
        for row in rows:
            for c in cols:
                val = row[c]
                # truncate long JSON/text for display
                display = str(val)
                if len(display) > 50:
                    display = display[:47] + "..."
                col_w[c] = max(col_w[c], len(display))

        # header
        header = "  " + "  ".join(c.ljust(col_w[c]) for c in cols)
        print(header)
        print("  " + "  ".join("-" * col_w[c] for c in cols))

        # rows
        for row in rows:
            parts = []
            for c in cols:
                val = row[c]
                display = str(val) if val is not None else "NULL"
                if len(display) > 50:
                    display = display[:47] + "..."
                parts.append(display.ljust(col_w[c]))
            print("  " + "  ".join(parts))

        # special: pretty-print waypoints JSON for the paths table
        if table == "paths" and rows:
            print()
            for row in rows:
                raw = row["waypoints"]
                try:
                    wps = json.loads(raw)
                    print(f"  📍 Path '{row['id']}' — {len(wps)} waypoints")
                    for i, wp in enumerate(wps[:3]):   # first 3
                        print(f"      [{i}] lat={wp['latitude']}  lon={wp['longitude']}"
                              f"  alt={wp['altitude']}m  t={wp['timestamp']}s")
                    if len(wps) > 3:
                        print(f"      ... and {len(wps)-3} more waypoints")
                except Exception:
                    pass

        print()

    conn.close()


# ── main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":

    # ── alerts.db ─────────────────────────────────────────────────────────────
    check_db(ALERTS_DB, "alerts.db  (stations / drones / alerts / active_dispatches)")

    # ── drone_paths.db ────────────────────────────────────────────────────────
    check_db(PATHS_DB,  "drone_paths.db  (paths)")

    print(SEP2)
    print("  Done.")
    print(SEP2)
