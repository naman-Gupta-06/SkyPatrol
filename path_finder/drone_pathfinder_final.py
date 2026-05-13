"""
Pune Drone Navigation — Final Hub Edition
==========================================
Updated to return a precise JSON schema, use strict Waypoint schema,
silence all console prints, and store paths using SQLite Option A.
"""

import sqlite3
import time
import math
import heapq
import os
import sys
import json
import uuid
from datetime import datetime
from typing import Optional

import numpy as np
from scipy.ndimage import distance_transform_edt, uniform_filter
from scipy.interpolate import make_interp_spline
from scipy.signal import savgol_filter
from shapely.wkt import loads as wkt_loads
from shapely.geometry import Point, Polygon
import pyproj
import yaml


# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────────────────────

import os as _os
_HERE = _os.path.dirname(_os.path.abspath(__file__))   # path_finder/
_ROOT = _os.path.dirname(_HERE)                         # project root

DB_PATH      = _os.path.join(_HERE, "pune_hub_buildings.db")
PATHS_DB     = _os.path.join(_ROOT, "database", "drone_paths.db")
ZONES_CONFIG = _os.path.join(_HERE, "restricted_zones.yaml")

GRID_RES_M        = 12.0
MAX_ALT_M         = 200.0
MIN_ALT_M         = 20.0
SAFETY_BUFFER_M   = 25.0
CORRIDOR_BUFFER_M = 200.0
DEFAULT_HEIGHT_M  = 14.0
MIN_CRUISE_ALT_M  = 50.0

W_DISTANCE    = 1.0
W_CLEARANCE   = 0.45
W_DENSITY     = 2.0
W_ALT_CHANGE  = 0.35
CLEARANCE_R_M = 20.0
CRUISE_PENALTY = 1.2

APF_K_ATT         = 1.0
APF_K_REP         = 600.0
APF_RHO0_M        = 20.0
APF_STEP_M        = 5.0
APF_MAX_ITERS     = 80
APF_STALL_THRESH  = 0.1

NURBS_DEGREE      = 3
NURBS_SAMPLE_M    = 30.0
ALT_SMOOTH_WIN    = 9
SG_WINDOW         = 9
SG_ORDER          = 3

WP_MIN_SEP_M      = 8.0

SOFT_BLOCK_PENALTY = 500.0
DRONE_SPEED_KMH    = 50.0  # Used for speed and timestamp calculation

CELL_FREE       = np.uint8(0)
CELL_BUILDING   = np.uint8(1)
CELL_HARD_BLOCK = np.uint8(2)
CELL_SOFT_BLOCK = np.uint8(3)

UTM_CRS   = "EPSG:32643"
WGS84_CRS = "EPSG:4326"

HUBS = [
    {
        "id":   "hub_a",
        "name": "South Pune  (Navale / Katraj / Hadapsar)",
        "lat":  18.4656,
        "lng":  73.8383,
    },
    {
        "id":   "hub_b",
        "name": "Northwest Pune  (Hinjewadi / Wakad / Baner)",
        "lat":  18.5995,
        "lng":  73.7620,
    },
    {
        "id":   "hub_c",
        "name": "East Pune  (Kharadi / Viman Nagar / Mundhwa)",
        "lat":  18.5519,
        "lng":  73.9476,
    },
]
HUB_RADIUS_M = 15000.0


# ─────────────────────────────────────────────────────────────────────────────
# PROGRESS HELPER (SILENCED)
# ─────────────────────────────────────────────────────────────────────────────

def _log(msg: str, indent: int = 2):
    """Silenced logging"""
    pass

# ─────────────────────────────────────────────────────────────────────────────
# COORDINATE TRANSFORMER
# ─────────────────────────────────────────────────────────────────────────────

class CoordinateTransformer:
    def __init__(self):
        self._to_utm   = pyproj.Transformer.from_crs(WGS84_CRS, UTM_CRS,   always_xy=True)
        self._to_wgs84 = pyproj.Transformer.from_crs(UTM_CRS,   WGS84_CRS, always_xy=True)

    def ll_to_utm(self, lat, lng):
        x, y = self._to_utm.transform(lng, lat)
        return x, y

    def utm_to_ll(self, e, n):
        lng, lat = self._to_wgs84.transform(e, n)
        return lat, lng


# ─────────────────────────────────────────────────────────────────────────────
# HAVERSINE
# ─────────────────────────────────────────────────────────────────────────────

def haversine(lat1, lng1, lat2, lng2) -> float:
    R = 6_371_000.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(dlng / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(max(0.0, a)))


# ─────────────────────────────────────────────────────────────────────────────
# HUB ZONE MANAGER
# ─────────────────────────────────────────────────────────────────────────────

class HubZoneManager:
    def __init__(self):
        self.hubs   = HUBS
        self.radius = HUB_RADIUS_M

    def which_hub(self, lat: float, lng: float) -> list[str]:
        return [h["id"] for h in self.hubs
                if haversine(lat, lng, h["lat"], h["lng"]) <= self.radius]

    def nearest_hub(self, lat: float, lng: float):
        best_hub  = min(self.hubs, key=lambda h: haversine(lat, lng, h["lat"], h["lng"]))
        best_dist = haversine(lat, lng, best_hub["lat"], best_hub["lng"])
        return best_hub, best_dist

    def snap_to_hub(self, lat: float, lng: float, hub: dict):
        dist = haversine(lat, lng, hub["lat"], hub["lng"])
        if dist <= self.radius:
            return lat, lng, False
        fraction = (self.radius * 0.95) / dist
        new_lat  = hub["lat"] + (lat - hub["lat"]) * fraction
        new_lng  = hub["lng"] + (lng - hub["lng"]) * fraction
        return new_lat, new_lng, True

    def resolve(self, start_ll, end_ll):
        warnings = []
        start_hubs = self.which_hub(*start_ll)
        end_hubs   = self.which_hub(*end_ll)
        common     = set(start_hubs) & set(end_hubs)

        if common:
            hub_id = sorted(common)[0]
            return start_ll, end_ll, hub_id, warnings

        for hub in self.hubs:
            s_dist = haversine(*start_ll, hub["lat"], hub["lng"])
            e_dist = haversine(*end_ll,   hub["lat"], hub["lng"])
            if s_dist <= self.radius * 1.5 and e_dist <= self.radius * 1.5:
                s_new_lat, s_new_lng, s_snapped = self.snap_to_hub(*start_ll, hub)
                e_new_lat, e_new_lng, e_snapped = self.snap_to_hub(*end_ll,   hub)
                return (s_new_lat, s_new_lng), (e_new_lat, e_new_lng), hub["id"], warnings

        start_hub, _ = self.nearest_hub(*start_ll)
        end_hub, _   = self.nearest_hub(*end_ll)
        s_new_lat, s_new_lng, s_snapped = self.snap_to_hub(*start_ll, start_hub)
        e_new_lat, e_new_lng, e_snapped = self.snap_to_hub(*end_ll, start_hub)

        return (s_new_lat, s_new_lng), (e_new_lat, e_new_lng), start_hub["id"], warnings


# ─────────────────────────────────────────────────────────────────────────────
# RESTRICTED ZONE LOADER
# ─────────────────────────────────────────────────────────────────────────────

class RestrictedZoneLoader:
    def __init__(self, config_path: str):
        self.zones = []
        if not os.path.exists(config_path):
            return
        with open(config_path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        now = datetime.now()
        for z in cfg.get("restricted_zones", []):
            af = z.get("active_from", "")
            au = z.get("active_until", "")
            if af and au:
                try:
                    if not (datetime.strptime(af, "%Y-%m-%d %H:%M") <= now
                            <= datetime.strptime(au, "%Y-%m-%d %H:%M")):
                        continue
                except ValueError:
                    pass
            self.zones.append(z)

    def get_zones(self):
        return self.zones


# ─────────────────────────────────────────────────────────────────────────────
# IN-MEMORY BUILDING INDEX
# ─────────────────────────────────────────────────────────────────────────────

class InMemoryBuildingIndex:
    def __init__(self, db_path: str):
        conn = sqlite3.connect(db_path)
        cur  = conn.cursor()
        cur.execute("""
            SELECT b.latitude, b.longitude,
                   b.height_m, b.min_height_m,
                   b.geometry_wkt, b.is_restricted,
                   r.min_lat, r.max_lat, r.min_lng, r.max_lng
            FROM   buildings b
            JOIN   buildings_rtree r ON b.id = r.id
        """)
        rows = cur.fetchall()
        conn.close()

        n = len(rows)
        self.n = n
        self.lat          = np.empty(n, dtype=np.float64)
        self.lng          = np.empty(n, dtype=np.float64)
        self.height_m_arr = np.empty(n, dtype=np.float64)
        self.min_h_arr    = np.empty(n, dtype=np.float64)
        self.restricted   = np.empty(n, dtype=np.int32)
        self.geometry_wkt = []

        self.bb_min_lat = np.empty(n, dtype=np.float64)
        self.bb_max_lat = np.empty(n, dtype=np.float64)
        self.bb_min_lng = np.empty(n, dtype=np.float64)
        self.bb_max_lng = np.empty(n, dtype=np.float64)

        for i, row in enumerate(rows):
            self.lat[i]          = row[0]
            self.lng[i]          = row[1]
            self.height_m_arr[i] = row[2] if row[2] is not None else -1.0
            self.min_h_arr[i]    = row[3] if row[3] is not None else 0.0
            self.geometry_wkt.append(row[4])
            self.restricted[i]   = row[5] if row[5] is not None else 0
            self.bb_min_lat[i]   = row[6]
            self.bb_max_lat[i]   = row[7]
            self.bb_min_lng[i]   = row[8]
            self.bb_max_lng[i]   = row[9]

    def query_bbox(self, min_lat: float, max_lat: float, min_lng: float, max_lng: float) -> list:
        mask = ((self.bb_max_lat >= min_lat) &
                (self.bb_min_lat <= max_lat) &
                (self.bb_max_lng >= min_lng) &
                (self.bb_min_lng <= max_lng))
        indices = np.where(mask)[0]
        results = []
        for i in indices:
            h = self.height_m_arr[i]
            results.append((
                self.lat[i], self.lng[i], h if h >= 0 else None,
                self.min_h_arr[i], self.geometry_wkt[i], int(self.restricted[i]),
            ))
        return results


# Path storage is handled by database/path_db.py (same pattern as alert_db.py).
# Import the thread-safe insert/update functions for use inside find_path().
from database.path_db import insert_path as _insert_path



# ─────────────────────────────────────────────────────────────────────────────
# VOXEL GRID & BUILDER
# ─────────────────────────────────────────────────────────────────────────────

class VoxelGrid:
    __slots__ = ("grid", "clearance", "density", "cost_extra",
                 "oe", "on_", "oz", "res", "nx", "ny", "nz")

    def __init__(self, nx, ny, nz, oe, on_, oz, res):
        self.grid       = np.zeros((nx, ny, nz), dtype=np.uint8)
        self.clearance  = np.full ((nx, ny, nz), 999.0, dtype=np.float32)
        self.density    = np.zeros((nx, ny, nz), dtype=np.uint8)
        self.cost_extra = np.zeros((nx, ny, nz), dtype=np.float32)
        self.oe, self.on_, self.oz = oe, on_, oz
        self.res = res
        self.nx, self.ny, self.nz = nx, ny, nz

    def w2v(self, e, n, z):
        xi = int((e  - self.oe)  / self.res)
        yi = int((n  - self.on_) / self.res)
        zi = int((z  - self.oz)  / self.res)
        return xi, yi, zi

    def v2w(self, xi, yi, zi):
        return (self.oe  + (xi + 0.5) * self.res,
                self.on_ + (yi + 0.5) * self.res,
                self.oz  + (zi + 0.5) * self.res)

    def in_bounds(self, xi, yi, zi):
        return 0 <= xi < self.nx and 0 <= yi < self.ny and 0 <= zi < self.nz

    def is_free(self, xi, yi, zi):
        return (self.in_bounds(xi, yi, zi) and
                self.grid[xi, yi, zi] != CELL_BUILDING and
                self.grid[xi, yi, zi] != CELL_HARD_BLOCK)


class VoxelGridBuilder:
    def __init__(self, mem_index: InMemoryBuildingIndex,
                 transformer: CoordinateTransformer, zone_loader: RestrictedZoneLoader):
        self.mem_index   = mem_index
        self.tf          = transformer
        self.zone_loader = zone_loader

    def build(self, start_ll, end_ll, res=GRID_RES_M, buffer_m=CORRIDOR_BUFFER_M) -> VoxelGrid:
        se, sn = self.tf.ll_to_utm(*start_ll)
        ee, en = self.tf.ll_to_utm(*end_ll)

        min_e = min(se, ee) - buffer_m
        max_e = max(se, ee) + buffer_m
        min_n = min(sn, en) - buffer_m
        max_n = max(sn, en) + buffer_m

        nx = max(1, math.ceil((max_e - min_e) / res))
        ny = max(1, math.ceil((max_n - min_n) / res))
        nz = max(1, math.ceil((MAX_ALT_M - MIN_ALT_M) / res))

        vg = VoxelGrid(nx, ny, nz, min_e, min_n, MIN_ALT_M, res)

        corners = [self.tf.utm_to_ll(e, n) for e, n in [(min_e, min_n), (max_e, max_n)]]
        q_min_lat = min(c[0] for c in corners)
        q_max_lat = max(c[0] for c in corners)
        q_min_lng = min(c[1] for c in corners)
        q_max_lng = max(c[1] for c in corners)

        buildings = self.mem_index.query_bbox(q_min_lat, q_max_lat, q_min_lng, q_max_lng)
        for i, b in enumerate(buildings):
            self._fill_building(b, vg)

        self._fill_restricted_zones(vg, q_min_lat, q_max_lat, q_min_lng, q_max_lng)

        obs_mask = (vg.grid > 0)
        if obs_mask.any():
            dist_vox     = distance_transform_edt(~obs_mask)
            vg.clearance = (dist_vox * res).astype(np.float32)
            vg.clearance[obs_mask] = 0.0

        obstacle_float = obs_mask.astype(np.float32)
        win            = max(3, int(round(50.0 / res)) | 1)
        density_raw    = uniform_filter(obstacle_float, size=win)
        d_max          = density_raw.max()
        if d_max > 0:
            vg.density = (density_raw / d_max * 255).astype(np.uint8)

        return vg

    def _fill_building(self, row, vg: VoxelGrid):
        lat, lng, height_m, min_h, geom_wkt, is_restricted = row
        if height_m is None or height_m <= 0:
            height_m = DEFAULT_HEIGHT_M
        if min_h is None:
            min_h = 0.0

        cell_val = CELL_HARD_BLOCK if is_restricted else CELL_BUILDING
        top_m    = height_m + SAFETY_BUFFER_M
        zi_start = max(0,       int((min_h - vg.oz) / vg.res))
        zi_end   = min(vg.nz-1, int(math.ceil((top_m - vg.oz) / vg.res)))

        if geom_wkt:
            try:
                self._rasterise_polygon(geom_wkt, vg, zi_start, zi_end, cell_val)
                return
            except Exception:
                pass

        e, n = self.tf.ll_to_utm(lat, lng)
        xi   = int((e - vg.oe)  / vg.res)
        yi   = int((n - vg.on_) / vg.res)
        for dxi in range(-1, 2):
            for dyi in range(-1, 2):
                if vg.in_bounds(xi+dxi, yi+dyi, 0):
                    vg.grid[xi+dxi, yi+dyi, zi_start:zi_end+1] = cell_val

    def _rasterise_polygon(self, geom_wkt, vg: VoxelGrid, zi_start, zi_end, cell_val):
        poly   = wkt_loads(geom_wkt)
        bounds = poly.bounds
        min_e, min_n = self.tf.ll_to_utm(bounds[1], bounds[0])
        max_e, max_n = self.tf.ll_to_utm(bounds[3], bounds[2])
        xi_min = max(0,       int((min_e - vg.oe)  / vg.res) - 1)
        xi_max = min(vg.nx-1, int((max_e - vg.oe)  / vg.res) + 1)
        yi_min = max(0,       int((min_n - vg.on_) / vg.res) - 1)
        yi_max = min(vg.ny-1, int((max_n - vg.on_) / vg.res) + 1)
        coords_ll  = list(poly.exterior.coords)
        vox_coords = []
        for (lng_c, lat_c) in coords_ll:
            e_c, n_c = self.tf.ll_to_utm(lat_c, lng_c)
            vox_coords.append(((e_c - vg.oe) / vg.res, (n_c - vg.on_) / vg.res))
        n_verts = len(vox_coords)
        for yi in range(yi_min, yi_max + 1):
            y_w = yi + 0.5
            crossings = []
            for k in range(n_verts - 1):
                x0, y0 = vox_coords[k]
                x1, y1 = vox_coords[k + 1]
                if (y0 <= y_w < y1) or (y1 <= y_w < y0):
                    if abs(y1 - y0) > 1e-9:
                        xc = x0 + (y_w - y0) * (x1 - x0) / (y1 - y0)
                        crossings.append(xc)
            crossings.sort()
            for pair in range(0, len(crossings) - 1, 2):
                xi_s = max(xi_min, int(math.ceil(crossings[pair])))
                xi_e = min(xi_max, int(crossings[pair + 1]))
                if xi_s <= xi_e:
                    vg.grid[xi_s:xi_e+1, yi, zi_start:zi_end+1] = cell_val

    def _fill_restricted_zones(self, vg, min_lat, max_lat, min_lng, max_lng):
        for zone in self.zone_loader.get_zones():
            hard     = zone.get("hard_block", True)
            cell_val = CELL_HARD_BLOCK if hard else CELL_SOFT_BLOCK
            shape    = zone.get("shape", "circle")
            if shape == "circle":
                c      = zone["center"]
                r      = zone["radius_m"]
                ce, cn = self.tf.ll_to_utm(c[0], c[1])
                xi_min = max(0,       int((ce - r - vg.oe)  / vg.res))
                xi_max = min(vg.nx-1, int((ce + r - vg.oe)  / vg.res))
                yi_min = max(0,       int((cn - r - vg.on_) / vg.res))
                yi_max = min(vg.ny-1, int((cn + r - vg.on_) / vg.res))
                for xi in range(xi_min, xi_max + 1):
                    for yi in range(yi_min, yi_max + 1):
                        e_, n_, _ = vg.v2w(xi, yi, 0)
                        if math.hypot(e_ - ce, n_ - cn) <= r:
                            vg.grid[xi, yi, :] = cell_val
                            if not hard:
                                vg.cost_extra[xi, yi, :] = SOFT_BLOCK_PENALTY
            elif shape == "polygon":
                coords = zone["polygon"]
                poly   = Polygon([(c[1], c[0]) for c in coords])
                if not poly.is_valid:
                    poly = poly.buffer(0)
                bounds = poly.bounds
                min_e, min_n = self.tf.ll_to_utm(bounds[1], bounds[0])
                max_e, max_n = self.tf.ll_to_utm(bounds[3], bounds[2])
                xi_min = max(0,       int((min_e - vg.oe)  / vg.res) - 1)
                xi_max = min(vg.nx-1, int((max_e - vg.oe)  / vg.res) + 1)
                yi_min = max(0,       int((min_n - vg.on_) / vg.res) - 1)
                yi_max = min(vg.ny-1, int((max_n - vg.on_) / vg.res) + 1)
                for xi in range(xi_min, xi_max + 1):
                    for yi in range(yi_min, yi_max + 1):
                        e_, n_, _ = vg.v2w(xi, yi, 0)
                        lat_, lng_ = self.tf.utm_to_ll(e_, n_)
                        if poly.contains(Point(lng_, lat_)):
                            vg.grid[xi, yi, :] = cell_val
                            if not hard:
                                vg.cost_extra[xi, yi, :] = SOFT_BLOCK_PENALTY


# ─────────────────────────────────────────────────────────────────────────────
# 26-CONNECTIVITY NEIGHBOUR TABLE
# ─────────────────────────────────────────────────────────────────────────────

_NBRS = np.array([(dx, dy, dz)
                  for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
                  if not (dx == dy == dz == 0)], dtype=np.int8)

_STEP_D = np.array([math.sqrt(int(dx)**2 + int(dy)**2 + int(dz)**2)
                    for dx, dy, dz in _NBRS], dtype=np.float32)

def compute_cruise_altitude(vg: VoxelGrid) -> int:
    min_cruise_zi = max(0, int((MIN_CRUISE_ALT_M - vg.oz) / vg.res))
    occupied_z    = np.where(vg.grid == CELL_BUILDING)
    if len(occupied_z[2]) == 0:
        return min_cruise_zi
    cruise_zi = int(np.percentile(occupied_z[2], 85)) + 1
    cruise_zi = min(max(cruise_zi, min_cruise_zi), vg.nz - 1)
    return cruise_zi


# ─────────────────────────────────────────────────────────────────────────────
# 3D A*
# ─────────────────────────────────────────────────────────────────────────────

class AStarPathfinder:
    def __init__(self, vg: VoxelGrid):
        self.vg  = vg
        self.res = vg.res

    def find_path(self, start: tuple, end: tuple, cruise_zi: int = None) -> Optional[list]:
        vg = self.vg
        nx, ny, nz = vg.nx, vg.ny, vg.nz

        if not vg.is_free(*start):
            start = self._nearest_free(start)
            if start is None: return None
        if not vg.is_free(*end):
            end = self._nearest_free(end)
            if end is None: return None

        if cruise_zi is None:
            cruise_zi = (start[2] + end[2]) // 2

        INF    = np.float32(1e9)
        g      = np.full((nx, ny, nz), INF,  dtype=np.float32)
        vis    = np.zeros((nx, ny, nz),       dtype=np.bool_)
        parent = np.full((nx, ny, nz), -1,   dtype=np.int32)

        def flat(xi, yi, zi): return xi * ny * nz + yi * nz + zi

        g[start] = 0.0
        heap     = [(self._h(start, end, cruise_zi), start[0], start[1], start[2])]

        while heap:
            f, xi, yi, zi = heapq.heappop(heap)
            if vis[xi, yi, zi]: continue
            vis[xi, yi, zi] = True

            if (xi, yi, zi) == end:
                return self._reconstruct(parent, start, end, ny, nz)

            g_cur = float(g[xi, yi, zi])
            for k in range(26):
                dx, dy, dz = int(_NBRS[k, 0]), int(_NBRS[k, 1]), int(_NBRS[k, 2])
                nx_, ny_, nz_ = xi + dx, yi + dy, zi + dz

                if not vg.in_bounds(nx_, ny_, nz_): continue
                if vis[nx_, ny_, nz_]: continue
                if not vg.is_free(nx_, ny_, nz_): continue

                step_m   = float(_STEP_D[k]) * self.res
                clr_m    = float(vg.clearance[nx_, ny_, nz_])
                clr_pen  = (W_CLEARANCE * (CLEARANCE_R_M - clr_m) if clr_m < CLEARANCE_R_M else 0.0)
                alt_pen  = W_ALT_CHANGE * abs(dz) * self.res
                extra    = float(vg.cost_extra[nx_, ny_, nz_])
                blw_crz  = max(0, cruise_zi - nz_)
                crz_pen  = CRUISE_PENALTY * blw_crz * self.res

                new_g = g_cur + step_m * W_DISTANCE + clr_pen + alt_pen + extra + crz_pen

                if new_g < g[nx_, ny_, nz_]:
                    g[nx_, ny_, nz_]      = new_g
                    parent[nx_, ny_, nz_] = flat(xi, yi, zi)
                    h = self._h((nx_, ny_, nz_), end, cruise_zi)
                    heapq.heappush(heap, (new_g + h, nx_, ny_, nz_))
        return None

    def _h(self, a: tuple, b: tuple, cruise_zi: int) -> float:
        dx, dy, dz = abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2])
        s  = sorted([dx, dy, dz], reverse=True)
        octile = (math.sqrt(3) * s[2] + math.sqrt(2) * (s[1] - s[2]) + (s[0] - s[1])) * self.res * W_DISTANCE
        dens  = float(self.vg.density[a]) / 255.0
        d_pen = min(dens * self.res * W_DENSITY, 0.5 * self.res * W_DISTANCE)
        return octile + d_pen

    def _reconstruct(self, parent, start, end, ny, nz) -> list:
        path = []
        node = end
        while node != start:
            path.append(node)
            p  = int(parent[node])
            if p < 0: break
            xi, yi, zi = p // (ny * nz), (p % (ny * nz)) // nz, p % nz
            node = (xi, yi, zi)
        path.append(start)
        path.reverse()
        return path

    def _nearest_free(self, pos, radius=10) -> Optional[tuple]:
        xi, yi, zi = pos
        vg = self.vg
        for dz in range(1, vg.nz - zi):
            c = (xi, yi, zi + dz)
            if vg.is_free(*c): return c
        for r in range(1, radius + 1):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    for dz in range(-r, r + 1):
                        c = (xi + dx, yi + dy, zi + dz)
                        if vg.is_free(*c): return c
        return None


# ─────────────────────────────────────────────────────────────────────────────
# APF LOCAL SMOOTHER
# ─────────────────────────────────────────────────────────────────────────────

class APFSmoother:
    def __init__(self, vg: VoxelGrid):
        self.vg = vg

    def refine(self, skeleton_world: list) -> list:
        if len(skeleton_world) < 2: return skeleton_world
        refined = [skeleton_world[0]]
        n_segs  = len(skeleton_world) - 1
        for seg_idx in range(n_segs):
            p_start = np.array(skeleton_world[seg_idx],     dtype=np.float64)
            p_end   = np.array(skeleton_world[seg_idx + 1], dtype=np.float64)
            if not self._segment_near_obstacle(p_start, p_end):
                refined.append(tuple(p_end))
                continue
            seg_pts = self._run_apf(p_start, p_end)
            refined.extend(seg_pts[1:])
        return refined

    def _segment_near_obstacle(self, p0, p1) -> bool:
        n_checks = max(2, int(np.linalg.norm(p1 - p0) / (self.vg.res * 2)))
        for t in np.linspace(0, 1, n_checks):
            pt = p0 + t * (p1 - p0)
            xi, yi, zi = self.vg.w2v(*pt)
            if not self.vg.in_bounds(xi, yi, zi): continue
            if float(self.vg.clearance[xi, yi, zi]) < APF_RHO0_M: return True
        return False

    def _run_apf(self, p_start, p_end) -> list:
        pos, goal, pts, stall_cnt = p_start.copy(), p_end.copy(), [tuple(p_start)], 0
        for _ in range(APF_MAX_ITERS):
            diff_g, dist_g = goal - pos, np.linalg.norm(goal - pos)
            if dist_g < APF_STEP_M:
                pts.append(tuple(goal))
                break
            f_att = APF_K_ATT * diff_g / dist_g
            f_rep = self._repulsive_force(pos)
            f_net = f_att + f_rep
            mag   = np.linalg.norm(f_net)
            if mag < 1e-9:
                stall_cnt += 1
                if stall_cnt >= 5:
                    pts.append(tuple(goal))
                    break
                continue
            else: stall_cnt = 0
            move    = f_net / mag * APF_STEP_M
            new_pos = pos + move
            vg = self.vg
            new_pos[0] = np.clip(new_pos[0], vg.oe,  vg.oe  + vg.nx * vg.res)
            new_pos[1] = np.clip(new_pos[1], vg.on_, vg.on_ + vg.ny * vg.res)
            new_pos[2] = np.clip(new_pos[2], vg.oz,  vg.oz  + vg.nz * vg.res)
            xi, yi, zi = vg.w2v(*new_pos)
            if vg.in_bounds(xi, yi, zi) and not vg.is_free(xi, yi, zi):
                new_pos[2] += vg.res
                xi, yi, zi  = vg.w2v(*new_pos)
                if not (vg.in_bounds(xi, yi, zi) and vg.is_free(xi, yi, zi)):
                    pts.append(tuple(goal))
                    break
            pos = new_pos
            pts.append(tuple(pos))
        return pts

    def _repulsive_force(self, pos) -> np.ndarray:
        vg = self.vg
        xi, yi, zi = vg.w2v(*pos)
        f_rep = np.zeros(3, dtype=np.float64)
        scan_r = min(2, max(1, int(APF_RHO0_M / vg.res) + 1))
        for dx in range(-scan_r, scan_r + 1):
            for dy in range(-scan_r, scan_r + 1):
                for dz in range(-scan_r, scan_r + 1):
                    ox, oy, oz = xi + dx, yi + dy, zi + dz
                    if not vg.in_bounds(ox, oy, oz) or vg.grid[ox, oy, oz] == CELL_FREE: continue
                    oe_, on__, oz_ = vg.v2w(ox, oy, oz)
                    obs_pos = np.array([oe_, on__, oz_])
                    diff = pos - obs_pos
                    rho = np.linalg.norm(diff)
                    if rho < 1e-3 or rho > APF_RHO0_M: continue
                    coeff = APF_K_REP * (1.0 / rho - 1.0 / APF_RHO0_M) / (rho ** 2)
                    f_rep += coeff * diff / rho
        return f_rep


# ─────────────────────────────────────────────────────────────────────────────
# PATH SMOOTHING
# ─────────────────────────────────────────────────────────────────────────────

def smooth_path(world_points: list, sample_spacing_m: float = NURBS_SAMPLE_M) -> list:
    if len(world_points) < 2: return world_points
    pts = _angle_truncate(world_points, angle_thresh_deg=5.0)
    if len(pts) < 2: return world_points
    if len(pts) == 2: return pts

    pts_arr = np.array(pts, dtype=np.float64)
    degree  = min(NURBS_DEGREE, len(pts_arr) - 1)
    diffs   = np.diff(pts_arr, axis=0)
    dists   = np.sqrt((diffs ** 2).sum(axis=1))
    dists   = np.where(dists < 1e-9, 1e-9, dists)
    t_param = np.concatenate([[0], np.cumsum(dists)])
    t_param /= t_param[-1]

    try:
        spline   = make_interp_spline(t_param, pts_arr, k=degree)
        total_m  = float(np.sum(dists))
        n_sample = max(2, int(total_m / sample_spacing_m))
        t_dense  = np.linspace(0, 1, n_sample)
        smooth   = spline(t_dense)
    except Exception:
        return pts

    if smooth.shape[0] > ALT_SMOOTH_WIN:
        z_raw    = smooth[:, 2].copy()
        kernel   = np.ones(ALT_SMOOTH_WIN) / ALT_SMOOTH_WIN
        z_sm     = np.convolve(z_raw, kernel, mode='same')
        z_sm[0], z_sm[-1] = z_raw[0], z_raw[-1]
        z_sm     = np.clip(z_sm, MIN_ALT_M, MAX_ALT_M)
        smooth[:, 2] = z_sm

    if smooth.shape[0] > SG_WINDOW:
        win = min(SG_WINDOW, smooth.shape[0] if smooth.shape[0] % 2 == 1 else smooth.shape[0] - 1)
        try:
            smooth[:, 0] = savgol_filter(smooth[:, 0], win, SG_ORDER)
            smooth[:, 1] = savgol_filter(smooth[:, 1], win, SG_ORDER)
        except Exception:
            pass

    return [tuple(r) for r in smooth]

def _angle_truncate(pts: list, angle_thresh_deg: float) -> list:
    if len(pts) <= 2: return pts
    thresh_rad = math.radians(angle_thresh_deg)
    kept = [pts[0]]
    for i in range(1, len(pts) - 1):
        v1 = np.array(pts[i])   - np.array(pts[i - 1])
        v2 = np.array(pts[i + 1]) - np.array(pts[i])
        n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
        if n1 < 1e-9 or n2 < 1e-9: continue
        cos_a = np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0)
        if math.acos(cos_a) > thresh_rad: kept.append(pts[i])
    kept.append(pts[-1])
    return kept


# ─────────────────────────────────────────────────────────────────────────────
# OUTPUT CONVERSION & METRICS (JSON SCHEMA)
# ─────────────────────────────────────────────────────────────────────────────

def world_to_waypoints(world_pts: list, tf: CoordinateTransformer) -> list:
    raw = []
    speed_ms = DRONE_SPEED_KMH * (1000 / 3600)
    
    for e, n, z in world_pts:
        lat, lng = tf.utm_to_ll(e, n)
        alt = max(MIN_ALT_M, min(MAX_ALT_M, round(float(z), 1)))
        raw.append({
            "latitude": round(lat, 6),
            "longitude": round(lng, 6),
            "altitude": alt,
            "timestamp": 0.0,
            "speed": round(speed_ms, 2)
        })

    # Deduplicate — remove points closer than WP_MIN_SEP_M
    sep_deg = WP_MIN_SEP_M / 111_000.0
    wps     = [raw[0]]
    for wp in raw[1:]:
        prev = wps[-1]
        if (abs(wp["latitude"] - prev["latitude"]) > sep_deg or
                abs(wp["longitude"] - prev["longitude"]) > sep_deg):
            wps.append(wp)
    if wps[-1] != raw[-1]:
        wps.append(raw[-1])

    # Assign Timestamps based on haversine distance 
    current_time = 0.0
    wps[0]["timestamp"] = 0.0
    for i in range(1, len(wps)):
        a, b = wps[i - 1], wps[i]
        dlat = math.radians(b["latitude"] - a["latitude"])
        dlng = math.radians(b["longitude"] - a["longitude"])
        hav = (math.sin(dlat / 2) ** 2
             + math.cos(math.radians(a["latitude"]))
             * math.cos(math.radians(b["latitude"]))
             * math.sin(dlng / 2) ** 2)
        dist_m = 2 * 6_371_000.0 * math.asin(math.sqrt(max(0.0, hav)))
        
        current_time += dist_m / speed_ms
        wps[i]["timestamp"] = round(current_time, 2)

    return wps


def compute_metrics(waypoints: list) -> dict:
    if len(waypoints) < 2:
        return {"distance_km": 0.0}
    R = 6_371_000.0
    total_m = 0.0
    for i in range(1, len(waypoints)):
        a, b  = waypoints[i - 1], waypoints[i]
        dlat  = math.radians(b["latitude"] - a["latitude"])
        dlng  = math.radians(b["longitude"] - a["longitude"])
        hav   = (math.sin(dlat / 2) ** 2
                 + math.cos(math.radians(a["latitude"]))
                 * math.cos(math.radians(b["latitude"]))
                 * math.sin(dlng / 2) ** 2)
        h_m   = 2 * R * math.asin(math.sqrt(max(0.0, hav)))
        v_m   = abs(b["altitude"] - a["altitude"])
        total_m += math.sqrt(h_m ** 2 + v_m ** 2)
    return {
        "distance_km": round(total_m / 1000, 3)
    }


# ─────────────────────────────────────────────────────────────────────────────
# MAIN PATHFINDER (SILENCED & JSON RETURN)
# ─────────────────────────────────────────────────────────────────────────────

class PunePathfinder:
    def __init__(self, db_path: str = DB_PATH, zones_config: str = ZONES_CONFIG):
        if not os.path.exists(db_path):
            raise FileNotFoundError(f"Database not found: '{db_path}'")
        self.tf         = CoordinateTransformer()
        self.zones      = RestrictedZoneLoader(zones_config)
        self.mem_index  = InMemoryBuildingIndex(db_path)
        self.builder    = VoxelGridBuilder(self.mem_index, self.tf, self.zones)
        self.hub_mgr    = HubZoneManager()

    def find_path(self, start: tuple, end: tuple, drone_id: str = "D1",
                   incident_id: str = None, save_to_db: bool = True) -> dict:
        # Default altitudes
        start_alt = MIN_ALT_M
        end_alt   = MIN_ALT_M

        if len(start) == 3: start_ll, start_alt = start[:2], float(start[2])
        else: start_ll = tuple(start)
        if len(end) == 3: end_ll, end_alt = end[:2], float(end[2])
        else: end_ll = tuple(end)

        try:
            start_ll, end_ll, hub_id, warnings = self.hub_mgr.resolve(start_ll, end_ll)
        except Exception as e:
            return {"error": str(e)}

        vg = self.builder.build(start_ll, end_ll)

        se, sn = self.tf.ll_to_utm(*start_ll)
        ee, en = self.tf.ll_to_utm(*end_ll)
        sv = vg.w2v(se, sn, start_alt)
        ev = vg.w2v(ee, en, end_alt)

        if not vg.in_bounds(*sv) or not vg.in_bounds(*ev):
            return {"error": "Start or End is outside the voxel grid."}

        cruise_zi = compute_cruise_altitude(vg)

        pf         = AStarPathfinder(vg)
        raw_voxels = pf.find_path(sv, ev, cruise_zi=cruise_zi)

        if raw_voxels is None:
            return {"error": "A* could not find a viable path"}

        raw_world = [vg.v2w(*v) for v in raw_voxels]

        apf       = APFSmoother(vg)
        apf_world = apf.refine(raw_world)

        smooth    = smooth_path(apf_world)
        waypoints = world_to_waypoints(smooth, self.tf)
        metrics   = compute_metrics(waypoints)

        path_id    = str(uuid.uuid4())[:8]
        eta_s      = round(metrics.get("distance_km", 0) / DRONE_SPEED_KMH * 3600, 1)
        created_at = datetime.now().isoformat()

        # Only write to DB when explicitly requested.
        # During multi-station evaluation, save_to_db=False so nothing is persisted.
        if save_to_db:
            _insert_path(
                path_id=path_id,
                drone_id=drone_id,
                station_lat=start_ll[0],
                station_lon=start_ll[1],
                incident_lat=end_ll[0],
                incident_lon=end_ll[1],
                waypoints=waypoints,
                estimated_time=eta_s,
                created_at=created_at,
                incident_id=incident_id,
                is_minimum=True,
            )

        return {
            "id": path_id,
            "drone_id": drone_id,
            "incident_id": incident_id,
            "waypoints": waypoints,
            "total_distance": metrics.get("distance_km", 0),
            "estimated_time": eta_s,
            "created_at": created_at
        }


# ─────────────────────────────────────────────────────────────────────────────
# DEMO EXECUTION
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    pf = PunePathfinder()
    
    # Just an example of how to retrieve the exact JSON format specified:
    # (Commented so no prints run by default, as requested)
    # result = pf.find_path(
    #     start=(18.5204, 73.8567),
    #     end=(18.5220, 73.8580),
    #     drone_id="D1"
    # )
    # print(json.dumps(result, indent=2))
