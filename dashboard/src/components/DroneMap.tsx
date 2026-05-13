'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import type { Incident, Station, Waypoint } from '@/lib/mockData';

type RestrictedZone = {
  name?: string;
  type?: string;
  hard_block?: boolean;
  shape?: 'circle' | 'polygon';
  center?: [number, number];
  radius_m?: number;
  polygon?: [number, number][];
};

export interface MapMission {
  id: string;
  dispatchId?: string;
  droneId: string;
  alertId: string;
  stationId?: string | number;
  incidentType?: string;
  color: string;
  status: 'idle' | 'dispatched' | 'arrived' | 'returning';
  phase?: 'idle' | 'outbound' | 'arrived' | 'returning';
  progress: number;
  returnProgress?: number;
  battery?: number;
  lat: number;
  lon: number;
  altitude: number;
  speed: number;
  waypointIndex: number;
  waypointTotal: number;
  etaSeconds: number;
  distanceKm?: number;
  waypoints: Waypoint[];
}

export interface DroneMapProps {
  missions: MapMission[];
  selectedMissionId?: string;
  stations: Station[];
  incidents: Incident[];
  restrictedZones?: RestrictedZone[];
  wsConnected: boolean;
  onSelectMission?: (missionId: string) => void;
}

delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function pathCoords(waypoints: Waypoint[]): [number, number][] {
  return waypoints
    .filter((wp) => Number.isFinite(wp.latitude) && Number.isFinite(wp.longitude))
    .map((wp) => [wp.latitude, wp.longitude]);
}

function segmentForProgress(waypoints: Waypoint[], progress: number): number {
  if (waypoints.length < 2) return 0;
  const p = clamp01(progress);
  const totalTime = Number(waypoints[waypoints.length - 1]?.timestamp ?? 0);
  if (totalTime > 0) {
    const target = p * totalTime;
    for (let i = 0; i < waypoints.length - 1; i += 1) {
      if (target <= Number(waypoints[i + 1].timestamp ?? 0)) return i;
    }
    return waypoints.length - 2;
  }
  return Math.min(Math.floor(p * (waypoints.length - 1)), waypoints.length - 2);
}

function traveledCoords(mission: MapMission): [number, number][] {
  const coords = pathCoords(mission.waypoints);
  if (coords.length <= 1) return coords;
  const segIdx = segmentForProgress(mission.waypoints, mission.progress);
  const traveled = coords.slice(0, Math.min(segIdx + 1, coords.length));
  traveled.push([mission.lat, mission.lon]);
  return traveled;
}

function stationIcon(droneCount: number) {
  return L.divIcon({
    className: '',
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    html: `
      <div class="map-station-marker">
        <span>S</span>
        <small>${droneCount}</small>
      </div>
    `,
  });
}

function incidentIcon(status: string) {
  const color = status === 'pending' ? '#ffb300' : status === 'observed' ? '#38bdf8' : status === 'ignored' ? '#64748b' : '#ff3860';
  return L.divIcon({
    className: '',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    html: `<div class="map-incident-marker ${status}" style="--marker-color:${color}">!</div>`,
  });
}

function droneIcon(color: string, selected: boolean, label: string) {
  return L.divIcon({
    className: '',
    iconSize: selected ? [52, 52] : [44, 44],
    iconAnchor: selected ? [26, 26] : [22, 22],
    html: `
      <div class="map-drone-object ${selected ? 'selected' : ''}" style="--mission-color:${color}" title="${label}">
        <i class="rotor r1"></i>
        <i class="rotor r2"></i>
        <i class="rotor r3"></i>
        <i class="rotor r4"></i>
        <i class="arm h"></i>
        <i class="arm v"></i>
        <span class="body"></span>
      </div>
    `,
  });
}

function FitMapBounds({
  points,
  restrictedZones = [],
  fitKey,
}: {
  points: L.LatLngExpression[];
  restrictedZones?: RestrictedZone[];
  fitKey: string;
}) {
  const map = useMap();
  const fittedRef = useRef(false);

  useEffect(() => {
    if (fittedRef.current) return;
    const bounds = points.length ? L.latLngBounds(points) : L.latLngBounds([]);

    restrictedZones.forEach((zone) => {
      if (zone.shape === 'polygon' && zone.polygon?.length) {
        zone.polygon.forEach((point) => bounds.extend(point));
      }
      if (zone.shape === 'circle' && zone.center) {
        const [lat, lon] = zone.center;
        const radiusM = zone.radius_m ?? 0;
        const latDelta = radiusM / 111_000;
        const lonDelta = latDelta / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
        bounds.extend([lat - latDelta, lon - lonDelta]);
        bounds.extend([lat + latDelta, lon + lonDelta]);
      }
    });

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.14), { animate: false, maxZoom: 15 });
      fittedRef.current = true;
    }
  }, [fitKey, map, points, restrictedZones]);

  return null;
}

export default function DroneMap({
  missions,
  selectedMissionId,
  stations,
  incidents,
  restrictedZones = [],
  wsConnected,
  onSelectMission,
}: DroneMapProps) {
  const [mounted, setMounted] = useState(false);
  const [mapKey] = useState(() => `heimdall-map-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    setMounted(true);
  }, []);

  const visibleMissions = useMemo(
    () => missions.filter((mission) => mission.status !== 'idle').slice(0, 100),
    [missions],
  );
  const selectedMission = visibleMissions.find((mission) => mission.id === selectedMissionId) ?? visibleMissions[0];

  const fitKey = useMemo(() => {
    const missionKey = visibleMissions
      .map((mission) => {
        const first = mission.waypoints[0];
        const last = mission.waypoints[mission.waypoints.length - 1];
        return `${mission.id}:${mission.waypoints.length}:${first?.latitude}:${first?.longitude}:${last?.latitude}:${last?.longitude}`;
      })
      .join('|');
    const stationKey = stations.map((station) => `${station.id}:${station.latitude}:${station.longitude}`).join('|');
    const incidentKey = incidents.map((incident) => `${incident.id}:${incident.latitude}:${incident.longitude}`).join('|');
    const zoneKey = restrictedZones.map((zone) => `${zone.name}:${zone.shape}:${zone.center?.join(',')}:${zone.polygon?.length}`).join('|');
    return `${missionKey}::${stationKey}::${incidentKey}::${zoneKey}`;
  }, [incidents, restrictedZones, stations, visibleMissions]);

  const boundsPoints = useMemo(() => {
    const points: L.LatLngExpression[] = [];
    visibleMissions.forEach((mission) => pathCoords(mission.waypoints).forEach((point) => points.push(point)));
    stations.forEach((station) => points.push([station.latitude, station.longitude]));
    incidents.forEach((incident) => points.push([incident.latitude, incident.longitude]));
    return points;
  }, [fitKey]); // geometry-only key; FitMapBounds only uses it for first fit now

  const center: [number, number] = selectedMission?.waypoints[0]
    ? [selectedMission.waypoints[0].latitude, selectedMission.waypoints[0].longitude]
    : stations[0]
      ? [stations[0].latitude, stations[0].longitude]
      : [18.52, 73.86];

  return (
    <div className="relative w-full h-full overflow-hidden">
      <div className="absolute bottom-3 left-3 z-[1000] pointer-events-none">
        <div className="ops-panel px-3 py-2">
          <div className="section-label mb-2">Operational Layers</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono text-slate-300">
            <span><b className="text-cyan-300">{visibleMissions.length}</b> drone paths</span>
            <span><b className="text-amber-300">{stations.length}</b> stations</span>
            <span><b className="text-rose-300">{incidents.length}</b> incidents</span>
            <span><b className="text-orange-300">{restrictedZones.length}</b> zones</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] font-mono">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: wsConnected ? '#00ff87' : '#ffb300' }}
            />
            <span style={{ color: wsConnected ? '#00ff87' : '#ffb300' }}>
              {wsConnected ? 'Backend telemetry' : 'Local simulation'}
            </span>
          </div>
        </div>
      </div>

      {visibleMissions.length > 0 && (
        <div className="absolute top-3 right-3 z-[1000] flex max-w-[46%] flex-wrap justify-end gap-2">
          {visibleMissions.map((mission) => {
            const selected = mission.id === selectedMission?.id;
            return (
              <button
                key={mission.id}
                type="button"
                onClick={() => onSelectMission?.(mission.id)}
                className="mission-chip"
                style={{
                  borderColor: selected ? mission.color : 'rgba(148,163,184,0.22)',
                  background: selected ? `${mission.color}22` : 'rgba(9,17,31,0.9)',
                }}
              >
                <span className="mission-dot" style={{ background: mission.color }} />
                <span>D{mission.droneId}</span>
                <strong>
                  {mission.status === 'returning'
                    ? `RTB ${Math.round(clamp01(mission.returnProgress ?? 0) * 100)}%`
                    : `${Math.round(clamp01(mission.progress) * 100)}%`}
                </strong>
              </button>
            );
          })}
        </div>
      )}

      {mounted ? (
        <MapContainer
          key={mapKey}
          center={center}
          zoom={14}
          style={{ width: '100%', height: '100%' }}
          zoomControl
        >
          <FitMapBounds points={boundsPoints} restrictedZones={restrictedZones} fitKey={fitKey} />
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            maxZoom={19}
          />

          {restrictedZones.map((zone, idx) => {
            const color = zone.hard_block ? '#ff3860' : '#ffb300';
            const options = {
              color,
              weight: zone.hard_block ? 2.5 : 2,
              fillOpacity: zone.hard_block ? 0.16 : 0.1,
              dashArray: zone.hard_block ? undefined : '6, 6',
            };

            if (zone.shape === 'circle' && zone.center) {
              return (
                <Circle key={`zone-${idx}`} center={zone.center} radius={zone.radius_m ?? 0} pathOptions={options}>
                  <Popup>
                    <div className="map-popup">
                      <strong style={{ color }}>{zone.name}</strong>
                      <span>{zone.type}</span>
                      <span>{zone.hard_block ? 'No-fly area' : 'Caution area'}</span>
                    </div>
                  </Popup>
                </Circle>
              );
            }

            if (zone.shape === 'polygon' && zone.polygon?.length) {
              return (
                <Polygon key={`zone-${idx}`} positions={zone.polygon} pathOptions={options}>
                  <Popup>
                    <div className="map-popup">
                      <strong style={{ color }}>{zone.name}</strong>
                      <span>{zone.type}</span>
                      <span>{zone.hard_block ? 'No-fly area' : 'Caution area'}</span>
                    </div>
                  </Popup>
                </Polygon>
              );
            }

            return null;
          })}

          {stations.map((station) => {
            const drones = station.drones ?? [];
            const idleCount = drones.filter((drone) => drone.status === 'idle').length;
            return (
              <Marker
                key={`station-${station.id}`}
                position={[station.latitude, station.longitude]}
                icon={stationIcon(idleCount)}
              >
                <Popup>
                  <div className="map-popup min-w-[190px]">
                    <strong className="text-amber-300">{station.name ?? `Station ${station.id}`}</strong>
                    <span>Available: {idleCount}/{station.capacity} drones</span>
                    <span>{station.latitude.toFixed(5)}, {station.longitude.toFixed(5)}</span>
                    <div className="mt-2 grid gap-1">
                      {drones.map((drone) => (
                        <div key={drone.id} className="flex items-center justify-between gap-3 text-[11px]">
                          <span>D{drone.id} - {drone.status}</span>
                          <span>{Math.round(drone.battery ?? 100)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Popup>
              </Marker>
            );
          })}

          {incidents.map((incident) => (
            <Marker
              key={`incident-${incident.id}`}
              position={[incident.latitude, incident.longitude]}
              icon={incidentIcon(incident.status)}
            >
              <Popup>
                <div className="map-popup">
                  <strong className="text-rose-300">{incident.incident_type.toUpperCase()}</strong>
                  <span>Camera: {incident.camera_id}</span>
                  <span>Severity: {Math.round(incident.severity * 100)}%</span>
                  <span>Status: {incident.status}</span>
                </div>
              </Popup>
            </Marker>
          ))}

          {visibleMissions.map((mission) => {
            const planned = pathCoords(mission.waypoints);
            const traveled = traveledCoords(mission);
            const selected = mission.id === selectedMission?.id;

            return (
              <Fragment key={`mission-layer-${mission.id}`}>
                {planned.length > 1 && (
                  <Polyline
                    positions={planned}
                    pathOptions={{
                      color: mission.color,
                      weight: selected ? 3 : 2,
                      opacity: selected ? 0.68 : 0.28,
                      dashArray: selected ? '9, 9' : '5, 10',
                    }}
                  />
                )}
                {traveled.length > 1 && (
                  <Polyline
                    positions={traveled}
                    pathOptions={{
                      color: mission.color,
                      weight: selected ? 5 : 3,
                      opacity: selected ? 0.95 : 0.68,
                    }}
                  />
                )}
                <CircleMarker
                  center={[mission.lat, mission.lon]}
                  radius={selected ? 18 : 12}
                  pathOptions={{
                    color: mission.color,
                    weight: 1,
                    opacity: selected ? 0.75 : 0.45,
                    fillColor: mission.color,
                    fillOpacity: selected ? 0.12 : 0.08,
                  }}
                />
                <Marker
                  position={[mission.lat, mission.lon]}
                  icon={droneIcon(mission.color, selected, `D${mission.droneId}`)}
                  zIndexOffset={selected ? 1000 : 500}
                  eventHandlers={{
                    click: () => onSelectMission?.(mission.id),
                  }}
                >
                  <Popup>
                    <div className="map-popup min-w-[180px]">
                      <strong style={{ color: mission.color }}>Drone {mission.droneId}</strong>
                      <span>Mission: {mission.alertId}</span>
                      <span>Status: {mission.status}</span>
                      <span>Progress: {Math.round(clamp01(mission.progress) * 100)}%</span>
                      {mission.status === 'returning' && (
                        <span>Return: {Math.round(clamp01(mission.returnProgress ?? 0) * 100)}%</span>
                      )}
                      <span>Battery: {Math.round(mission.battery ?? 100)}%</span>
                      <span>Altitude: {Math.round(mission.altitude)} m</span>
                      <span>Speed: {mission.speed.toFixed(1)} km/h</span>
                    </div>
                  </Popup>
                </Marker>
              </Fragment>
            );
          })}
        </MapContainer>
      ) : (
        <div className="h-full w-full bg-slate-950" />
      )}
    </div>
  );
}
