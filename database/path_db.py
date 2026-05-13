# ============================================================
# database/path_db.py
# Persistent storage for drone_paths.db.
#
# Only ONE row is written per alert — the minimum-distance path.
# ============================================================

import sqlite3
import json
import threading
import os

_db_lock = threading.Lock()

_HERE   = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(_HERE, "drone_paths.db")


# ── Schema ────────────────────────────────────────────────────────────────────

def init_path_db() -> None:
    """Create / migrate drone_paths.db on startup (idempotent)."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS paths (
                id             TEXT PRIMARY KEY,
                drone_id       TEXT,
                station_lat    REAL,
                station_lon    REAL,
                incident_lat   REAL,
                incident_lon   REAL,
                waypoints      TEXT,
                estimated_time REAL,
                created_at     TEXT,
                incident_id    TEXT DEFAULT NULL,
                is_minimum     INTEGER DEFAULT 1
            )
        """)

        # Live migration: add new columns to databases created before this schema
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(paths)").fetchall()
        }
        if "incident_id" not in existing_cols:
            conn.execute("ALTER TABLE paths ADD COLUMN incident_id TEXT DEFAULT NULL")
            print("🔧  Migrated drone_paths.db: added 'incident_id' column")
        if "is_minimum" not in existing_cols:
            conn.execute("ALTER TABLE paths ADD COLUMN is_minimum INTEGER DEFAULT 1")
            print("🔧  Migrated drone_paths.db: added 'is_minimum' column")

        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_paths_incident
            ON paths(incident_id)
        """)
        conn.commit()
    print("✅ drone_paths.db initialised")


# ── Write ─────────────────────────────────────────────────────────────────────

def insert_path(
    path_id:        str,
    drone_id:       str,
    station_lat:    float,
    station_lon:    float,
    incident_lat:   float,
    incident_lon:   float,
    waypoints:      list,
    estimated_time: float,
    created_at:     str,
    incident_id:    str  = None,
    is_minimum:     bool = True,   # always True — only minimum paths are stored
) -> None:
    """
    Thread-safe insert of a path into drone_paths.db.

    This function is called ONCE per alert dispatch — only after the
    minimum-distance station has been identified in priority.py.
    """
    wp_json = json.dumps(waypoints)
    with _db_lock:
        try:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute(
                    """
                    INSERT INTO paths
                        (id, drone_id, station_lat, station_lon,
                         incident_lat, incident_lon,
                         waypoints, estimated_time, created_at,
                         incident_id, is_minimum)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        path_id, drone_id,
                        station_lat, station_lon,
                        incident_lat, incident_lon,
                        wp_json, estimated_time, created_at,
                        incident_id, int(is_minimum),
                    ),
                )
                conn.commit()
            print(
                f"⭐ MIN PATH SAVED  id={path_id}  "
                f"station=({station_lat:.4f},{station_lon:.4f})  "
                f"eta={estimated_time:.0f}s  incident={incident_id}"
            )
        except Exception as exc:
            print(f"❌ PATH INSERT FAILED: {exc}")


# ── Read ──────────────────────────────────────────────────────────────────────

def fetch_all_paths() -> list[dict]:
    """Return every stored minimum path, newest first."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM paths ORDER BY created_at DESC"
        ).fetchall()
    return _decode(rows)


def fetch_path_for_incident(incident_id: str) -> dict | None:
    """Return the stored minimum path for a given incident_id."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM paths WHERE incident_id = ? LIMIT 1",
            (incident_id,),
        ).fetchone()
    if row is None:
        return None
    d = dict(row)
    d["waypoints"] = json.loads(d["waypoints"])
    return d


def path_exists_for_incident(incident_id: str) -> bool:
    """Return True if a path has already been stored for this incident_id."""
    with sqlite3.connect(DB_PATH) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM paths WHERE incident_id = ?",
            (incident_id,),
        ).fetchone()[0]
    return count > 0


def delete_paths_for_incident(incident_id: str | None) -> None:
    """Remove completed incident paths so the map only reloads active missions."""
    if not incident_id:
        return
    with _db_lock:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("DELETE FROM paths WHERE incident_id = ?", (incident_id,))
            conn.commit()


def fetch_path_by_id(path_id: str) -> dict | None:
    """Return a single path record by its UUID."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM paths WHERE id = ?", (path_id,)
        ).fetchone()
    if row is None:
        return None
    d = dict(row)
    d["waypoints"] = json.loads(d["waypoints"])
    return d


def count_paths() -> int:
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute("SELECT COUNT(*) FROM paths").fetchone()[0]


def clear_all_paths() -> None:
    """Delete saved dispatch paths so each backend run starts from live state."""
    with _db_lock:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("DELETE FROM paths")
            conn.commit()
    print("drone_paths.db dynamic paths cleared.")


# ── Internal ──────────────────────────────────────────────────────────────────

def _decode(rows) -> list[dict]:
    result = []
    for r in rows:
        d = dict(r)
        d["waypoints"] = json.loads(d["waypoints"])
        result.append(d)
    return result
