export interface DroneSummary {
  id: number;
  status: 'idle' | 'dispatched' | 'arrived' | 'returning' | string;
  load_count: number;
  battery?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  progress?: number;
  return_progress?: number;
  phase?: string;
  mission_id?: string | null;
}

export interface Station {
  id: number;
  latitude: number;
  longitude: number;
  capacity: number;
  name?: string;
  drones?: DroneSummary[];
}

export interface Waypoint {
  latitude: number;
  longitude: number;
  altitude: number;
  timestamp: number;
  speed?: number;
}

export interface DroneDispatch {
  mission_id?: string;
  dispatch_id?: string;
  drone_id: string;
  alert_id: string;
  station_id?: number | string;
  incident_type?: string;
  distance_km?: number;
  eta_seconds: number;
  waypoints: Waypoint[];
}

export interface Incident {
  id: string;
  camera_id: string;
  incident_type: string;
  latitude: number;
  longitude: number;
  severity: number;
  confidence: number;
  timestamp: string;
  status: 'pending' | 'dispatched' | 'ignored' | 'observed';
}

export interface ExternalLog {
  id: number;
  timestamp: string;
  message: string;
  level: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
}

export const MOCK_STATIONS: Station[] = [
  {
    id: 1,
    latitude: 18.5346,
    longitude: 73.8655,
    capacity: 2,
    name: 'Central Response Station',
    drones: [
      { id: 1, status: 'idle', load_count: 0, battery: 100, latitude: 18.5346, longitude: 73.8655 },
      { id: 2, status: 'idle', load_count: 0, battery: 100, latitude: 18.5346, longitude: 73.8655 },
    ],
  },
  {
    id: 2,
    latitude: 18.5409,
    longitude: 73.9071,
    capacity: 2,
    name: 'East Response Station',
    drones: [
      { id: 3, status: 'idle', load_count: 0, battery: 100, latitude: 18.5409, longitude: 73.9071 },
      { id: 4, status: 'idle', load_count: 0, battery: 100, latitude: 18.5409, longitude: 73.9071 },
    ],
  },
];

export const MOCK_DISPATCH: DroneDispatch = {
  mission_id: 'mock-D-01',
  dispatch_id: 'mock-D-01',
  drone_id: 'D-01',
  alert_id: 'ALT-DEMO-001',
  station_id: 1,
  incident_type: 'accident',
  eta_seconds: 144,
  waypoints: [
    { latitude: 18.5346, longitude: 73.8655, altitude: 50, timestamp: 0, speed: 13.89 },
    { latitude: 18.5362, longitude: 73.8641, altitude: 65, timestamp: 28, speed: 13.89 },
    { latitude: 18.5378, longitude: 73.8634, altitude: 72, timestamp: 56, speed: 13.89 },
    { latitude: 18.5392667, longitude: 73.8633778, altitude: 55, timestamp: 84, speed: 13.89 },
    { latitude: 18.5392667, longitude: 73.8633778, altitude: 50, timestamp: 144, speed: 13.89 },
  ],
};

export const MOCK_INCIDENTS: Incident[] = [
  {
    id: 'ALT-DEMO-001',
    camera_id: 'cam_1',
    incident_type: 'accident',
    latitude: 18.5392667,
    longitude: 73.8633778,
    severity: 0.82,
    confidence: 0.89,
    timestamp: '2026-05-08T18:00:00.000Z',
    status: 'dispatched',
  },
  {
    id: 'ALT-DEMO-002',
    camera_id: 'cam_2',
    incident_type: 'crowd',
    latitude: 18.4954812,
    longitude: 73.9041143,
    severity: 0.58,
    confidence: 0.78,
    timestamp: '2026-05-08T17:58:00.000Z',
    status: 'pending',
  },
];

export const LOG_TEMPLATES = [
  (wp: number, lat: string, lon: string) =>
    `Drone passing waypoint ${wp} - GPS (${lat}, ${lon})`,
  (wp: number, lat: string, lon: string) =>
    `Telemetry OK at WP-${wp}: lat=${lat} lon=${lon}`,
  (wp: number, lat: string, lon: string) =>
    `Battery nominal - ETA recalculated at WP-${wp} (${lat}, ${lon})`,
  (wp: number, lat: string, lon: string) =>
    `Signal strong - active route WP-${wp} (${lat}, ${lon})`,
];
