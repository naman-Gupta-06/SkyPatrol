'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import {
  Activity,
  Camera,
  ChevronLeft,
  ChevronRight,
  Layers,
  Map as MapIcon,
  Radio,
  ShieldAlert,
  Zap,
} from 'lucide-react';

import ActivityLog from '@/components/ActivityLog';
import CCTVFeed from '@/components/CCTVFeed';
import Header from '@/components/Header';
import IncidentTable from '@/components/IncidentTable';
import TelemetryHUD from '@/components/TelemetryHUD';
import { API_BASE, WS_URL, fetchBackendData, fetchBackendRecord } from '@/lib/backend';
import {
  MOCK_STATIONS,
} from '@/lib/mockData';
import type {
  DroneDispatch,
  ExternalLog,
  Incident,
  Station,
  Waypoint,
} from '@/lib/mockData';
import type { DroneMapProps, MapMission } from '@/components/DroneMap';

const DroneMap = dynamic<DroneMapProps>(() => import('@/components/DroneMap'), {
  ssr: false,
});

const MISSION_COLORS = ['#00d4ff', '#00ff87', '#ffb300', '#ff3860', '#a78bfa', '#38bdf8'];
const LOCAL_SIMULATION_SPEED_SCALE = 20;
const MAX_LOGS = 100;
const MAX_MAP_MISSIONS = 100;

let extLogId = 1000;

interface StoredPath {
  drone_id: string | number;
  incident_id: string | null;
  id: string;
  station_lat?: number;
  station_lon?: number;
  incident_lat?: number;
  incident_lon?: number;
  estimated_time: number;
  waypoints: Waypoint[];
}

interface FleetRecord {
  lat?: number;
  lon?: number;
  altitude?: number;
  speed?: number;
  progress?: number;
  return_progress?: number;
  battery?: number;
  mission_id?: string | null;
  status?: string;
  phase?: string;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function numberOr(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function missionStatusFrom(value: unknown): MapMission['status'] | null {
  const status = String(value ?? '');
  if (status === 'idle' || status === 'dispatched' || status === 'arrived' || status === 'returning') {
    return status;
  }
  return null;
}

function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return MISSION_COLORS[hash % MISSION_COLORS.length];
}

function makeExtLog(message: string, level: ExternalLog['level'] = 'INFO'): ExternalLog {
  return {
    id: ++extLogId,
    timestamp: new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }),
    message,
    level,
  };
}

function pruneMissions(record: Record<string, MapMission>): Record<string, MapMission> {
  const entries = Object.entries(record).filter(([, mission]) => mission.status !== 'idle');
  if (entries.length <= MAX_MAP_MISSIONS) return Object.fromEntries(entries);

  const order: Record<MapMission['status'], number> = {
    dispatched: 0,
    arrived: 1,
    returning: 2,
    idle: 3,
  };

  return Object.fromEntries(
    entries
      .sort(([, a], [, b]) => {
        if (a.status !== b.status) return order[a.status] - order[b.status];
        return a.droneId.localeCompare(b.droneId, undefined, { numeric: true });
      })
      .slice(0, MAX_MAP_MISSIONS),
  );
}

function normaliseWaypoints(waypoints: Waypoint[] = []): Waypoint[] {
  const clean = waypoints
    .filter((wp) => Number.isFinite(Number(wp.latitude)) && Number.isFinite(Number(wp.longitude)))
    .map((wp) => ({
      latitude: Number(wp.latitude),
      longitude: Number(wp.longitude),
      altitude: Number(wp.altitude ?? 0),
      timestamp: Number(wp.timestamp ?? 0),
      speed: Number(wp.speed ?? 13.89),
    }));

  if (clean.length < 2) return clean;

  let elapsed = 0;
  return clean.map((wp, idx) => {
    if (idx === 0) {
      elapsed = 0;
      return { ...wp, timestamp: 0 };
    }
    elapsed = Math.max(elapsed + 0.05, wp.timestamp);
    return { ...wp, timestamp: Number(elapsed.toFixed(3)) };
  });
}

function missionIdFromDispatch(dispatch: DroneDispatch): string {
  return String(
    dispatch.mission_id ??
    dispatch.dispatch_id ??
    `${dispatch.drone_id}:${dispatch.alert_id}`,
  );
}

function interpolateAtProgress(waypoints: Waypoint[], progress: number) {
  const p = clamp01(progress);
  if (!waypoints.length) return { lat: 0, lon: 0, altitude: 0, speed: 0, waypointIndex: 0 };
  if (waypoints.length === 1 || p <= 0) {
    const first = waypoints[0];
    return {
      lat: first.latitude,
      lon: first.longitude,
      altitude: first.altitude,
      speed: Number(first.speed ?? 0) * 3.6,
      waypointIndex: 0,
    };
  }

  const totalTime = Number(waypoints[waypoints.length - 1].timestamp ?? 0);
  let segIdx = 0;
  let t = p;

  if (totalTime > 0) {
    const target = p * totalTime;
    for (let i = 0; i < waypoints.length - 1; i += 1) {
      const aTime = Number(waypoints[i].timestamp ?? 0);
      const bTime = Number(waypoints[i + 1].timestamp ?? aTime);
      if (target <= bTime || i === waypoints.length - 2) {
        segIdx = i;
        t = bTime > aTime ? (target - aTime) / (bTime - aTime) : 0;
        break;
      }
    }
  } else {
    const scaled = p * (waypoints.length - 1);
    segIdx = Math.min(Math.floor(scaled), waypoints.length - 2);
    t = scaled - segIdx;
  }

  const a = waypoints[segIdx];
  const b = waypoints[segIdx + 1] ?? a;
  return {
    lat: a.latitude + t * (b.latitude - a.latitude),
    lon: a.longitude + t * (b.longitude - a.longitude),
    altitude: a.altitude + t * (b.altitude - a.altitude),
    speed: Number(a.speed ?? 0) * 3.6,
    waypointIndex: segIdx,
  };
}

function makeMissionFromDispatch(dispatch: DroneDispatch, previous?: MapMission): MapMission {
  const waypoints = normaliseWaypoints(dispatch.waypoints);
  const id = missionIdFromDispatch(dispatch);
  const isIdle = dispatch.mission_id === 'idle' || dispatch.drone_id === 'waiting';
  const first = waypoints[0] ?? { latitude: 0, longitude: 0, altitude: 0, timestamp: 0, speed: 0 };
  const initial = previous
    ? { lat: previous.lat, lon: previous.lon, altitude: previous.altitude, speed: previous.speed, waypointIndex: previous.waypointIndex }
    : interpolateAtProgress(waypoints, 0);

  return {
    id,
    dispatchId: dispatch.dispatch_id,
    droneId: String(dispatch.drone_id),
    alertId: String(dispatch.alert_id),
    stationId: dispatch.station_id,
    incidentType: dispatch.incident_type,
    color: previous?.color ?? colorForKey(id),
    status: isIdle ? 'idle' : previous?.status === 'returning' ? 'returning' : previous?.status === 'arrived' ? 'arrived' : 'dispatched',
    phase: isIdle ? 'idle' : previous?.phase ?? 'outbound',
    progress: previous?.progress ?? 0,
    returnProgress: previous?.returnProgress ?? 0,
    battery: previous?.battery ?? 100,
    lat: initial.lat || first.latitude,
    lon: initial.lon || first.longitude,
    altitude: initial.altitude,
    speed: initial.speed,
    waypointIndex: initial.waypointIndex,
    waypointTotal: waypoints.length,
    etaSeconds: Number(dispatch.eta_seconds ?? waypoints[waypoints.length - 1]?.timestamp ?? 0),
    distanceKm: dispatch.distance_km,
    waypoints,
  };
}

function makeMissionFromPath(path: StoredPath, fleet: Record<string, FleetRecord>, previous?: MapMission): MapMission {
  const waypoints = normaliseWaypoints(path.waypoints);
  const droneId = String(path.drone_id ?? 'unknown');
  const fleetState = fleet[droneId];
  const id = String(fleetState?.mission_id ?? path.id ?? `${droneId}:${path.incident_id ?? 'path'}`);
  const progress = clamp01(Number(fleetState?.progress ?? previous?.progress ?? 0));
  const returnProgress = clamp01(Number(fleetState?.return_progress ?? previous?.returnProgress ?? 0));
  const interpolated = interpolateAtProgress(waypoints, progress);
  const liveStatus = missionStatusFrom(fleetState?.status);
  const status = liveStatus ?? (progress >= 1 ? 'arrived' : 'dispatched');

  return {
    id,
    dispatchId: path.id,
    droneId,
    alertId: String(path.incident_id ?? path.id),
    color: previous?.color ?? colorForKey(id),
    status,
    phase: (fleetState?.phase as MapMission['phase']) ?? (status === 'returning' ? 'returning' : status === 'idle' ? 'idle' : progress >= 1 ? 'arrived' : 'outbound'),
    progress,
    returnProgress,
    battery: Number(fleetState?.battery ?? previous?.battery ?? 100),
    lat: Number(fleetState?.lat ?? interpolated.lat),
    lon: Number(fleetState?.lon ?? interpolated.lon),
    altitude: Number(fleetState?.altitude ?? interpolated.altitude),
    speed: fleetState?.speed != null ? Number(fleetState.speed) * 3.6 : interpolated.speed,
    waypointIndex: interpolated.waypointIndex,
    waypointTotal: waypoints.length,
    etaSeconds: Number(path.estimated_time ?? waypoints[waypoints.length - 1]?.timestamp ?? 0),
    waypoints,
  };
}

function makeIdleDispatch(stations: Station[]): DroneDispatch {
  const home = stations[0] ?? MOCK_STATIONS[0];
  const waypoint: Waypoint = {
    latitude: home.latitude,
    longitude: home.longitude,
    altitude: 0,
    timestamp: 0,
    speed: 0,
  };

  return {
    mission_id: 'idle',
    drone_id: 'waiting',
    alert_id: 'awaiting-detection',
    eta_seconds: 0,
    waypoints: [waypoint, waypoint],
  };
}

export default function HeimdallDashboard() {
  const [stations, setStations] = useState<Station[]>(MOCK_STATIONS);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [missionsById, setMissionsById] = useState<Record<string, MapMission>>({});
  const [selectedMissionId, setSelectedMissionId] = useState<string>('');
  const [restrictedZones, setRestrictedZones] = useState<DroneMapProps['restrictedZones']>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [externalLogs, setExternalLogs] = useState<ExternalLog[]>([]);
  const [feedsOpen, setFeedsOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<'map' | 'incidents' | 'fleet' | 'logs' | 'zones'>('map');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const missionsRef = useRef(missionsById);
  const mapPanelRef = useRef<HTMLElement | null>(null);
  const incidentsPanelRef = useRef<HTMLElement | null>(null);
  const fleetPanelRef = useRef<HTMLElement | null>(null);
  const logsPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    missionsRef.current = missionsById;
  }, [missionsById]);

  const missions = useMemo(
    () => Object.values(missionsById).sort((a, b) => {
      const order: Record<MapMission['status'], number> = {
        dispatched: 0,
        returning: 1,
        arrived: 2,
        idle: 3,
      };
      if (a.status !== b.status) return order[a.status] - order[b.status];
      return a.droneId.localeCompare(b.droneId, undefined, { numeric: true });
    }).slice(0, MAX_MAP_MISSIONS),
    [missionsById],
  );
  const selectedMission = missionsById[selectedMissionId] ?? missions[0];
  const activeMissionCount = missions.filter((mission) => mission.status === 'dispatched').length;

  const focusPanel = useCallback((panel: 'map' | 'incidents' | 'fleet' | 'logs' | 'zones') => {
    setActivePanel(panel);
    const target = {
      map: mapPanelRef.current,
      zones: mapPanelRef.current,
      incidents: incidentsPanelRef.current,
      fleet: fleetPanelRef.current,
      logs: logsPanelRef.current,
    }[panel];
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    target?.focus({ preventScroll: true });
  }, []);

  const pushLogFn = useCallback((message: string, level: ExternalLog['level'] = 'INFO') => {
    setExternalLogs((prev) => {
      const entry = makeExtLog(message, level);
      const next = [...prev, entry];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  }, []);
  const pushLogRef = useRef(pushLogFn);

  useEffect(() => {
    pushLogRef.current = pushLogFn;
  }, [pushLogFn]);

  const upsertMission = useCallback((dispatch: DroneDispatch) => {
    const id = missionIdFromDispatch(dispatch);
    setMissionsById((prev) => {
      const mission = makeMissionFromDispatch(dispatch, prev[id]);
      return pruneMissions({ ...prev, [id]: mission });
    });
    setSelectedMissionId(id);
  }, []);

  const findMissionKey = useCallback((data: Record<string, unknown>, current: Record<string, MapMission>) => {
    const eventId = String(data.mission_id ?? data.dispatch_id ?? '');
    if (eventId && current[eventId]) return eventId;

    const droneId = String(data.drone_id ?? '');
    const byDrone = Object.values(current).find(
      (mission) => mission.droneId === droneId && mission.status !== 'idle',
    );
    return byDrone?.id ?? eventId;
  }, []);

  const loadBackendSnapshot = useCallback(async () => {
    try {
      const [nextStations, nextIncidents, paths, zones, fleet] = await Promise.all([
        fetchBackendData<Station>('/api/stations'),
        fetchBackendData<Incident>('/api/incidents'),
        fetchBackendData<StoredPath>('/api/paths'),
        fetchBackendData<NonNullable<DroneMapProps['restrictedZones']>[number]>('/api/restricted_zones'),
        fetchBackendRecord<FleetRecord>('/api/fleet_state'),
      ]);

      const liveStations = nextStations.length ? nextStations : MOCK_STATIONS;
      setStations(liveStations);
      setIncidents(nextIncidents);
      setRestrictedZones(zones);

      if (!paths.length) {
        setMissionsById({});
        setSelectedMissionId('');
        return;
      }

      setMissionsById((prev) => {
        const next: Record<string, MapMission> = {};
        paths.forEach((path) => {
          const existing = prev[String(path.id)] ?? Object.values(prev).find((mission) => mission.droneId === String(path.drone_id));
          const mission = makeMissionFromPath(path, fleet, existing);
          next[mission.id] = mission;
        });
        return pruneMissions(next);
      });
      const firstPath = paths[0];
      const firstFleetId = firstPath ? fleet[String(firstPath.drone_id)]?.mission_id : null;
      setSelectedMissionId(String(firstFleetId ?? firstPath?.id ?? ''));
    } catch {
      /* Keep mock data until the backend is available. */
    }
  }, []);

  useEffect(() => {
    loadBackendSnapshot();
  }, [loadBackendSnapshot]);

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      pushLogRef.current('WebSocket connected - backend telemetry active', 'SUCCESS');
      loadBackendSnapshot();
    };

    ws.onmessage = (evt) => {
      let parsed: { event: string; data: Record<string, unknown> };
      try {
        parsed = JSON.parse(evt.data as string);
      } catch {
        return;
      }

      const { event: evtName, data } = parsed;

      switch (evtName) {
        case 'live_telemetry': {
          setMissionsById((prev) => {
            const currentKey = findMissionKey(data, prev);
            const existing = currentKey ? prev[currentKey] : undefined;
            if (!existing) return prev;

            const incomingProgress = clamp01(numberOr(data.progress, existing.progress));
            const incomingReturnProgress = clamp01(numberOr(data.return_progress, existing.returnProgress ?? 0));
            const incomingStatus = missionStatusFrom(data.status)
              ?? (String(data.phase ?? '') === 'returning' ? 'returning' : null);
            const nextStatus: MapMission['status'] =
              incomingStatus ?? (incomingProgress >= 1 ? 'arrived' : 'dispatched');

            if (nextStatus === 'dispatched' && incomingProgress + 0.001 < existing.progress) {
              return prev;
            }

            const nextKey = String(data.mission_id ?? data.dispatch_id ?? currentKey);
            const nextProgress = Math.max(existing.progress, incomingProgress);
            const next: Record<string, MapMission> = { ...prev };
            if (nextKey !== currentKey) delete next[currentKey];

            next[nextKey] = {
              ...existing,
              id: nextKey,
              dispatchId: String(data.dispatch_id ?? existing.dispatchId ?? nextKey),
              alertId: String(data.alert_id ?? existing.alertId),
              stationId: (data.station_id as string | number | undefined) ?? existing.stationId,
              phase: (data.phase as MapMission['phase'] | undefined) ?? (nextStatus === 'returning' ? 'returning' : existing.phase),
              lat: numberOr(data.lat, existing.lat),
              lon: numberOr(data.lon, existing.lon),
              altitude: numberOr(data.altitude, existing.altitude),
              speed: numberOr(data.speed, 0) * 3.6,
              battery: numberOr(data.battery, existing.battery ?? 100),
              progress: nextProgress,
              returnProgress: incomingReturnProgress,
              waypointIndex: numberOr(data.waypoint_index, existing.waypointIndex),
              waypointTotal: numberOr(data.waypoint_total, existing.waypointTotal),
              status: nextStatus,
            };
            return pruneMissions(next);
          });
          const droneId = String(data.drone_id ?? '');
          if (droneId) {
            setStations((prev) => prev.map((station) => ({
              ...station,
              drones: station.drones?.map((drone) => (
                String(drone.id) === droneId
                  ? {
                      ...drone,
                      status: missionStatusFrom(data.status) ?? (String(data.phase ?? '') === 'returning' ? 'returning' : drone.status),
                      battery: numberOr(data.battery, drone.battery ?? 100),
                      latitude: numberOr(data.lat, drone.latitude ?? station.latitude),
                      longitude: numberOr(data.lon, drone.longitude ?? station.longitude),
                      progress: numberOr(data.progress, drone.progress ?? 0),
                      return_progress: numberOr(data.return_progress, drone.return_progress ?? 0),
                      phase: String(data.phase ?? drone.phase ?? ''),
                    }
                  : drone
              )),
            })));
          }
          break;
        }

        case 'drone_dispatched': {
          const wps = (data.waypoints as Waypoint[]) ?? [];
          if (!wps.length) break;
          const droneId = String(data.drone_id ?? 'D-01');
          const stationId = String(data.station_id ?? '');

          upsertMission({
            mission_id: String(data.mission_id ?? data.dispatch_id ?? ''),
            dispatch_id: String(data.dispatch_id ?? ''),
            drone_id: droneId,
            alert_id: String(data.alert_id ?? ''),
            station_id: data.station_id as string | number | undefined,
            incident_type: String(data.incident_type ?? ''),
            distance_km: Number(data.distance_km ?? 0),
            eta_seconds: Number(data.eta_seconds ?? 0),
            waypoints: wps,
          });
          setStations((prev) => prev.map((station) => (
            String(station.id) === stationId
              ? {
                  ...station,
                  drones: station.drones?.map((drone) => (
                    String(drone.id) === droneId
                      ? {
                          ...drone,
                          status: 'dispatched',
                          mission_id: String(data.mission_id ?? data.dispatch_id ?? ''),
                          progress: 0,
                          phase: 'outbound',
                        }
                      : drone
                  )),
                }
              : station
          )));
          setIncidents((prev) =>
            prev.map((incident) =>
              incident.id === String(data.alert_id ?? '')
                ? { ...incident, status: 'dispatched' }
                : incident,
            ),
          );
          pushLogRef.current(
            `Dispatch: station ${String(data.station_id ?? '?')} selected drone ${String(data.drone_id ?? '?')} for alert ${String(data.alert_id ?? '?')}`,
            'SUCCESS',
          );
          break;
        }

        case 'new_alert': {
          const alert = {
            ...(data as unknown as Incident),
            status: 'pending' as const,
          };
          setIncidents((prev) => [
            alert,
            ...prev.filter((incident) => incident.id !== alert.id),
          ].slice(0, 100));
          pushLogRef.current(
            `Incident: ${String(data.incident_type ?? '').toUpperCase()} at ${Number(data.latitude).toFixed(4)}, ${Number(data.longitude).toFixed(4)}`,
            'WARNING',
          );
          break;
        }

        case 'drone_arrived': {
          setMissionsById((prev) => {
            const key = findMissionKey(data, prev);
            const mission = key ? prev[key] : undefined;
            if (!mission) return prev;
            return {
              ...prev,
              [key]: {
                ...mission,
                lat: numberOr(data.lat, mission.lat),
                lon: numberOr(data.lon, mission.lon),
                progress: 1,
                returnProgress: 0,
                battery: numberOr(data.battery, mission.battery ?? 100),
                phase: 'arrived',
                speed: 0,
                status: 'arrived',
              },
            };
          });
          pushLogRef.current(
            `Arrived: drone ${String(data.drone_id ?? '')} reached alert ${String(data.alert_id ?? '')}`,
            'SUCCESS',
          );
          break;
        }

        case 'drone_returning': {
          setMissionsById((prev) => {
            const key = findMissionKey(data, prev);
            const mission = key ? prev[key] : undefined;
            if (!mission) return prev;
            return {
              ...prev,
              [key]: {
                ...mission,
                lat: numberOr(data.lat, mission.lat),
                lon: numberOr(data.lon, mission.lon),
                progress: 1,
                returnProgress: 0,
                battery: numberOr(data.battery, mission.battery ?? 100),
                phase: 'arrived',
                speed: 0,
                status: 'arrived',
              },
            };
          });
          pushLogRef.current(
            `Reset queued: drone ${String(data.drone_id ?? '')} will teleport back to station ${String(data.station_id ?? '')}`,
            'INFO',
          );
          break;
        }

        case 'incident_observed': {
          const alertId = String(data.alert_id ?? '');
          setIncidents((prev) => prev.map((incident) => (
            incident.id === alertId
              ? { ...incident, status: 'observed' }
              : incident
          )));
          pushLogRef.current(
            `Observed: alert ${alertId} has been verified by drone ${String(data.drone_id ?? '')}`,
            'SUCCESS',
          );
          break;
        }

        case 'drone_returned': {
          const droneId = String(data.drone_id ?? '');
          setMissionsById((prev) => {
            const key = findMissionKey(data, prev);
            const mission = key ? prev[key] : undefined;
            if (!mission) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
          setSelectedMissionId('');
          setStations((prev) => prev.map((station) => ({
            ...station,
            drones: station.drones?.map((drone) => (
              String(drone.id) === droneId
                ? {
                    ...drone,
                    status: 'idle',
                    battery: numberOr(data.battery, drone.battery ?? 100),
                    latitude: numberOr(data.lat, station.latitude),
                    longitude: numberOr(data.lon, station.longitude),
                    progress: 0,
                    return_progress: 0,
                    phase: 'idle',
                  }
                : drone
            )),
          })));
          pushLogRef.current(
            `Returned: drone ${droneId} is idle at station ${String(data.station_id ?? '')}`,
            'SUCCESS',
          );
          break;
        }

        case 'system_log': {
          const lvlMap: Record<string, ExternalLog['level']> = {
            SUCCESS: 'SUCCESS',
            WARNING: 'WARNING',
            ERROR: 'ERROR',
            INFO: 'INFO',
          };
          const lvl = lvlMap[String(data.level ?? 'INFO')] ?? 'INFO';
          pushLogRef.current(String(data.message ?? ''), lvl);
          break;
        }

        default:
          break;
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
      pushLogRef.current('WebSocket disconnected - local simulation holding paths steady', 'WARNING');
      reconnectRef.current = setTimeout(connectWs, 3000);
    };

    ws.onerror = () => {
      pushLogRef.current('WebSocket error - backend is offline or still starting', 'ERROR');
    };
  }, [findMissionKey, loadBackendSnapshot, upsertMission]);

  useEffect(() => {
    connectWs();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connectWs]);

  useEffect(() => {
    if (wsConnected) return undefined;

    const interval = setInterval(() => {
      setMissionsById((prev) => {
        let changed = false;
        const nextEntries: [string, MapMission][] = Object.entries(prev).flatMap(([id, mission]): [string, MapMission][] => {
          if (mission.status === 'returning') {
            const home = mission.waypoints[0];
            changed = true;
            return [[
              id,
              {
                ...mission,
                returnProgress: 0,
                lat: home?.latitude ?? mission.lat,
                lon: home?.longitude ?? mission.lon,
                altitude: home?.altitude ?? mission.altitude,
                speed: 0,
                phase: 'idle',
                status: 'idle',
              } satisfies MapMission,
            ]];
          }

          if (mission.status !== 'dispatched' || mission.progress >= 1) {
            return [[id, mission]];
          }

          const routeSeconds = Number(
            mission.waypoints[mission.waypoints.length - 1]?.timestamp ??
            mission.etaSeconds ??
            60,
          );
          const increment = (0.25 * LOCAL_SIMULATION_SPEED_SCALE) / Math.max(routeSeconds, 1);
          const nextProgress = clamp01(mission.progress + increment);
          const interpolated = interpolateAtProgress(mission.waypoints, nextProgress);
          const complete = nextProgress >= 1;
          const home = mission.waypoints[0];
          changed = true;
          return [[
            id,
            {
              ...mission,
              progress: nextProgress,
              lat: complete && home ? home.latitude : interpolated.lat,
              lon: complete && home ? home.longitude : interpolated.lon,
              altitude: complete && home ? home.altitude : interpolated.altitude,
              speed: complete ? 0 : interpolated.speed,
              battery: complete ? 100 : mission.battery,
              waypointIndex: interpolated.waypointIndex,
              returnProgress: 0,
              phase: complete ? 'idle' : 'outbound',
              status: complete ? 'idle' : 'dispatched',
            } satisfies MapMission,
          ]];
        });
        const next = pruneMissions(Object.fromEntries(nextEntries));
        return changed ? next : prev;
      });
    }, 250);

    return () => clearInterval(interval);
  }, [wsConnected]);

  const displayedMission = selectedMission ?? makeMissionFromDispatch(makeIdleDispatch(stations));
  const status = displayedMission.status;

  const cameraMeta = useMemo(() => {
    const byCamera = new Map<string, Incident>();
    incidents.forEach((incident) => {
      const existing = byCamera.get(incident.camera_id);
      if (!existing || incident.status === 'pending') byCamera.set(incident.camera_id, incident);
    });
    return byCamera;
  }, [incidents]);

  const cameraStatus = (cameraId: string): 'live' | 'alert' =>
    cameraMeta.get(cameraId)?.status === 'pending' ? 'alert' : 'live';

  const fleetDrones = useMemo(
    () => stations.flatMap((station) => (station.drones ?? []).map((drone) => ({ ...drone, station }))),
    [stations],
  );
  const totalDrones = fleetDrones.length || stations.reduce((sum, station) => sum + station.capacity, 0);
  const idleDroneCount = fleetDrones.filter((drone) => drone.status === 'idle').length;
  const pendingIncidentCount = incidents.filter((incident) => incident.status === 'pending').length;

  const feedCards = [
    {
      id: 'cctv-feed-1',
      label: 'CAM-01 / INPUT 1',
      src: `${API_BASE}/api/video/input1.mp4`,
      cameraId: 'cam_1',
    },
    {
      id: 'cctv-feed-2',
      label: 'CAM-02 / INPUT 2',
      src: `${API_BASE}/api/video/input2.mp4`,
      cameraId: 'cam_2',
    },
    {
      id: 'cctv-feed-3',
      label: 'CAM-03 / INPUT 3',
      src: `${API_BASE}/api/video/input3.mp4`,
      cameraId: 'cam_3',
    },
  ];

  return (
    <div className="h-screen flex flex-col bg-grid overflow-hidden" style={{ background: 'var(--bg-900)' }}>
      <Header
        droneStatus={status}
        activeMissions={activeMissionCount}
        wsConnected={wsConnected}
        totalDrones={totalDrones}
      />

      <div className="relative flex-1 flex gap-3 overflow-hidden p-3 pt-2">
        <nav className="command-rail">
          {[
            { icon: MapIcon, label: 'Map', id: 'map' as const },
            { icon: ShieldAlert, label: 'Incidents', id: 'incidents' as const },
            { icon: Radio, label: 'Fleet', id: 'fleet' as const },
            { icon: Activity, label: 'Logs', id: 'logs' as const },
            { icon: Layers, label: 'Zones', id: 'zones' as const },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              className={activePanel === item.id ? 'active' : ''}
              title={item.label}
              aria-label={item.label}
              aria-pressed={activePanel === item.id}
              onClick={() => focusPanel(item.id)}
            >
              <item.icon size={16} />
            </button>
          ))}
        </nav>

        <main className="operation-grid min-w-0 flex-1">
          <section
            ref={mapPanelRef}
            tabIndex={-1}
            className={`ops-panel overflow-hidden min-h-0 ${activePanel === 'map' || activePanel === 'zones' ? 'panel-focus' : ''}`}
          >
            <DroneMap
              missions={missions}
              selectedMissionId={displayedMission.id}
              stations={stations}
              incidents={incidents}
              restrictedZones={restrictedZones}
              wsConnected={wsConnected}
              onSelectMission={setSelectedMissionId}
            />
          </section>

          <aside className="flex min-h-0 flex-col gap-3 overflow-hidden">
            <TelemetryHUD
              progress={displayedMission.progress}
              returnProgress={displayedMission.returnProgress ?? 0}
              battery={displayedMission.battery}
              lat={displayedMission.lat}
              lon={displayedMission.lon}
              wpIdx={displayedMission.waypointIndex}
              wpTotal={displayedMission.waypointTotal}
              droneId={displayedMission.droneId}
              status={status}
              etaSeconds={displayedMission.etaSeconds}
              liveAltitude={displayedMission.altitude}
              liveSpeed={displayedMission.speed}
              wsConnected={wsConnected}
              activeMissionCount={activeMissionCount}
            />
            <div
              ref={logsPanelRef}
              tabIndex={-1}
              className={`min-h-0 flex-1 overflow-hidden ${activePanel === 'logs' ? 'panel-focus' : ''}`}
            >
              <ActivityLog
                droneId={displayedMission.droneId}
                droneLat={displayedMission.lat}
                droneLon={displayedMission.lon}
                waypointIdx={displayedMission.waypointIndex}
                droneStatus={status}
                wsConnected={wsConnected}
                externalLogs={externalLogs}
              />
            </div>
          </aside>

          <section
            ref={incidentsPanelRef}
            tabIndex={-1}
            className={`min-h-0 overflow-hidden ${activePanel === 'incidents' ? 'panel-focus' : ''}`}
          >
            <IncidentTable incidents={incidents} />
          </section>

          <section
            ref={fleetPanelRef}
            tabIndex={-1}
            className={`glass-panel fleet-panel min-h-0 overflow-hidden ${activePanel === 'fleet' ? 'panel-focus' : ''}`}
          >
            <div className="flex items-center justify-between border-b border-slate-700/40 px-4 py-3">
              <div className="flex items-center gap-2">
                <Radio size={14} className="text-cyber-cyan" />
                <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-white">
                  Stations & Fleet
                </h2>
              </div>
              <span className="section-label text-cyber-green">{idleDroneCount} idle</span>
            </div>
            <div className="grid grid-cols-4 gap-2 p-3">
              <FleetKpi icon={<Zap size={13} />} label="Drones" value={String(totalDrones)} tone="cyan" />
              <FleetKpi icon={<Activity size={13} />} label="Active" value={String(activeMissionCount)} tone="green" />
              <FleetKpi icon={<ChevronLeft size={13} />} label="Idle" value={String(idleDroneCount)} tone="amber" />
              <FleetKpi icon={<ShieldAlert size={13} />} label="Pending" value={String(pendingIncidentCount)} tone="red" />
            </div>
            <div className="fleet-station-list px-3 pb-3">
              {stations.map((station) => (
                <div key={station.id} className="fleet-station">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-mono text-xs font-bold text-white">
                        {station.name ?? `Station ${station.id}`}
                      </div>
                      <div className="section-label mt-0.5">
                        {station.latitude.toFixed(4)}, {station.longitude.toFixed(4)}
                      </div>
                    </div>
                    <span className="rounded border border-amber-400/20 bg-amber-400/10 px-2 py-1 font-mono text-[10px] text-amber-300">
                      {(station.drones ?? []).filter((drone) => drone.status === 'idle').length}/{station.capacity}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {(station.drones ?? []).map((drone) => {
                      const battery = Math.round(drone.battery ?? 100);
                      const statusTone = drone.status === 'idle'
                        ? 'text-cyber-green'
                        : drone.status === 'returning'
                          ? 'text-amber-300'
                          : 'text-cyber-cyan';
                      return (
                        <button
                          key={drone.id}
                          type="button"
                          className="fleet-drone"
                          onClick={() => {
                            const mission = missions.find((item) => item.droneId === String(drone.id));
                            if (mission) setSelectedMissionId(mission.id);
                          }}
                        >
                          <span className="font-mono text-xs font-bold text-white">D{drone.id}</span>
                          <span className={`font-mono text-[10px] uppercase ${statusTone}`}>{drone.status}</span>
                          <span className="battery-line">
                            <i style={{ width: `${battery}%` }} />
                          </span>
                          <span className="font-mono text-[10px] text-slate-400">{battery}%</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </main>

        <aside className={`live-feed-sidebar ${feedsOpen ? 'open' : 'closed'}`}>
          <div className="flex items-center justify-between border-b border-slate-700/40 px-4 py-3">
            <div className="flex items-center gap-2">
              <Camera size={14} className="text-cyber-cyan" />
              <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-white">
                Live Feed
              </h2>
            </div>
            <span className="section-label text-cyber-green">{feedCards.length} active</span>
          </div>
          <div className="live-feed-stack">
            {feedCards.map((feed) => (
              <CCTVFeed
                key={feed.id}
                id={feed.id}
                label={feed.label}
                src={feed.src}
                status={cameraStatus(feed.cameraId)}
                incidentType={cameraMeta.get(feed.cameraId)?.incident_type}
              />
            ))}
          </div>
        </aside>

        <button
          type="button"
          className={`live-feed-tab ${feedsOpen ? 'open' : 'closed'}`}
          onClick={() => setFeedsOpen((value) => !value)}
          aria-expanded={feedsOpen}
          title={feedsOpen ? 'Close live feed' : 'Open live feed'}
        >
          {feedsOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          <span>LIVE FEED</span>
        </button>
      </div>
    </div>
  );
}

function FleetKpi({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: 'cyan' | 'green' | 'amber' | 'red';
}) {
  const tones = {
    cyan: 'text-cyber-cyan border-cyan-400/15 bg-cyan-400/5',
    green: 'text-cyber-green border-green-400/15 bg-green-400/5',
    amber: 'text-amber-300 border-amber-400/15 bg-amber-400/5',
    red: 'text-cyber-red border-red-400/15 bg-red-400/5',
  };

  return (
    <div className={`rounded-md border px-3 py-2 ${tones[tone]}`}>
      <div className="flex items-center justify-between gap-2">
        {icon}
        <span className="font-mono text-base font-black leading-none">{value}</span>
      </div>
      <div className="section-label mt-1">{label}</div>
    </div>
  );
}
