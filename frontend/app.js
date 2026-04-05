/* ═══════════════════════════════════════════════════════════════════════
   app.js — AEGIS Drone Command Dashboard
   Pure vanilla JS. All data from FastAPI backend on port 5001.
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

// ── CONSTANTS ───────────────────────────────────────────────────────────────
const API = 'http://localhost:5001';
const WS_URL = 'ws://localhost:5001/ws';

const PUNE_CENTER = [18.5204, 73.8567];
const INCIDENT_TYPES_LABEL = {
  fight: 'Physical Altercation',
  weapon: 'Weapon Detected',
  fire: 'Fire / Smoke',
  accident: 'Road Accident',
  crowd: 'Crowd Surge',
  vandalism: 'Vandalism',
  intrusion: 'Intrusion',
  default: 'Incident Detected',
};

// ── STATE ───────────────────────────────────────────────────────────────────
const state = {
  ws: null,
  wsConnected: false,
  stations: [],       // [{id, latitude, longitude, capacity}]
  drones: {},         // { droneId: {lat, lon, battery, status, ...} }
  incidents: [],      // from /api/incidents sorted by severity
  paths: [],          // from /api/paths
  activeMissions: {}, // droneId → {path, progress, eta, ...}

  // Leaflet layers
  stationMarkers: {},
  droneMarkers: {},
  incidentMarkers: {},
  pathPolylines: {},
  dronePathLines: {},
};

// ── CLOCK ──────────────────────────────────────────────────────────────────
(function startClock() {
  const clockEl = document.getElementById('clock');
  const dateEl  = document.getElementById('date');
  function tick() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('en-IN', {hour12: false});
    dateEl.textContent  = now.toLocaleDateString('en-IN', {weekday:'short', day:'2-digit', month:'short', year:'numeric'});
  }
  tick();
  setInterval(tick, 1000);
})();

// ── MAP INIT ────────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: PUNE_CENTER,
  zoom: 13,
  zoomControl: true,
  attributionControl: false,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
}).addTo(map);

// Map controls
document.getElementById('btn-center').addEventListener('click', () => {
  map.setView(PUNE_CENTER, 13);
});

let showPaths = true, showStations = true;

document.getElementById('btn-paths').addEventListener('click', function() {
  showPaths = !showPaths;
  this.classList.toggle('active', showPaths);
  Object.values(state.pathPolylines).forEach(layer => showPaths ? layer.addTo(map) : map.removeLayer(layer));
  Object.values(state.dronePathLines).forEach(layer => showPaths ? layer.addTo(map) : map.removeLayer(layer));
});

document.getElementById('btn-stations').addEventListener('click', function() {
  showStations = !showStations;
  this.classList.toggle('active', showStations);
  Object.values(state.stationMarkers).forEach(m => showStations ? m.addTo(map) : map.removeLayer(m));
});

// ── MARKER HELPERS ──────────────────────────────────────────────────────────
function makeStationIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="station-marker-icon">
             <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#00d4ff" stroke-width="2">
               <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
               <polyline points="9 22 9 12 15 12 15 22"/>
             </svg>
           </div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -20],
  });
}

function makeDroneIcon(busy = false) {
  return L.divIcon({
    className: 'leaflet-drone-master',
    html: `<div class="drone-marker-icon ${busy ? 'busy' : ''}">
             <svg viewBox="0 0 24 24" width="14" height="14" fill="${busy ? '#ffb547' : '#00ff88'}" stroke="none">
               <path d="M12 2C8 2 5 5 5 8a7 7 0 0 0 7 7 7 7 0 0 0 7-7c0-3-3-6-7-6z"/>
               <rect x="4" y="10" width="4" height="2" rx="1"/>
               <rect x="16" y="10" width="4" height="2" rx="1"/>
               <rect x="10" y="4" width="4" height="2" rx="1" transform="rotate(-45 12 5)"/>
               <rect x="10" y="17" width="4" height="2" rx="1" transform="rotate(45 12 18)"/>
               <circle cx="12" cy="12" r="2"/>
             </svg>
           </div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

function makeIncidentIcon(severity) {
  const color = severity >= 0.7 ? '#ff4b6e' : severity >= 0.4 ? '#ffb547' : '#4d9dff';
  return L.divIcon({
    className: '',
    html: `<div class="incident-marker-icon" style="border-color:${color}; background:${color}28; box-shadow:0 0 16px ${color}44">
             <svg viewBox="0 0 24 24" width="14" height="14" fill="${color}">
               <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
               <line x1="12" y1="9" x2="12" y2="13" stroke="#fff" stroke-width="2"/>
               <circle cx="12" cy="17" r="1" fill="#fff"/>
             </svg>
           </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -16],
  });
}

// ── UTILITY ─────────────────────────────────────────────────────────────────
function severityClass(s) {
  if (s >= 0.7) return 'high';
  if (s >= 0.4) return 'medium';
  return 'low';
}

function formatTime(iso) {
  if (!iso) return '--';
  try { return new Date(iso).toLocaleTimeString('en-IN', {hour12: false}); }
  catch { return iso; }
}

function fmtCoords(lat, lon) {
  return `${Number(lat).toFixed(4)}°N ${Number(lon).toFixed(4)}°E`;
}

function fmtKm(km) {
  if (!km) return '–';
  return `${Number(km).toFixed(2)} km`;
}

function getIncidentLabel(type) {
  return INCIDENT_TYPES_LABEL[type?.toLowerCase()] || INCIDENT_TYPES_LABEL.default;
}

// ── LOG SYSTEM ──────────────────────────────────────────────────────────────
const logContainer = document.getElementById('system-logs');
const MAX_LOGS = 100;

function addLog(msg, level = 'info') {
  const now = new Date();
  const time = now.toLocaleTimeString('en-IN', {hour12: false});
  const el = document.createElement('div');
  el.className = `log-entry ${level.toLowerCase()}`;
  el.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  logContainer.appendChild(el);
  // Auto-scroll to bottom
  logContainer.scrollTop = logContainer.scrollHeight;
  // Trim old entries
  while (logContainer.children.length > MAX_LOGS) {
    logContainer.removeChild(logContainer.firstChild);
  }
}

document.getElementById('clear-logs').addEventListener('click', () => {
  logContainer.innerHTML = '';
  addLog('Logs cleared.', 'info');
});

// ── HEADER COUNTER UPDATES ──────────────────────────────────────────────────
function updateHeaders() {
  const totalDrones  = Object.keys(state.drones).length;
  const activeMis    = Object.keys(state.activeMissions).length;
  const incidents    = state.incidents.length;
  document.getElementById('header-drone-count').textContent    = totalDrones;
  document.getElementById('header-incident-count').textContent = incidents;
  document.getElementById('header-active-count').textContent   = activeMis;
}

// ── RENDER STATIONS ─────────────────────────────────────────────────────────
function renderStations() {
  const list = document.getElementById('stations-list');
  document.getElementById('station-count').textContent = state.stations.length;

  if (!state.stations.length) {
    list.innerHTML = '<div class="empty-state">No stations found</div>';
    return;
  }

  list.innerHTML = '';
  state.stations.forEach(s => {
    const el = document.createElement('div');
    el.className = 'station-item';
    el.id = `station-${s.id}`;

    // Find drones for this station
    const stationDrones = Object.entries(state.drones)
      .filter(([, d]) => d.station_id === s.id);

    const droneChips = stationDrones.length
      ? stationDrones.map(([id, d]) =>
          `<div class="drone-chip ${d.status === 'busy' ? 'busy' : 'idle'}">
             <svg class="drone-icon" viewBox="0 0 24 24" fill="${d.status === 'busy' ? '#ffb547' : '#00ff88'}">
               <circle cx="12" cy="12" r="6"/>
             </svg>
             D${id} · ${d.battery ? Math.round(d.battery) + '%' : '?%'}
           </div>`
        ).join('')
      : '<div style="font-size:9px;color:var(--text-muted);padding:2px 0">No drone data</div>';

    el.innerHTML = `
      <div class="station-header">
        <span class="station-id">STA-${s.id}</span>
        <span class="station-coords">${fmtCoords(s.latitude, s.longitude)}</span>
      </div>
      <div class="station-drones">${droneChips}</div>
    `;

    el.addEventListener('click', () => {
      map.setView([s.latitude, s.longitude], 15);
      if (state.stationMarkers[s.id]) state.stationMarkers[s.id].openPopup();
    });

    list.appendChild(el);

    // Map marker
    if (!state.stationMarkers[s.id]) {
      const marker = L.marker([s.latitude, s.longitude], {icon: makeStationIcon()})
        .bindPopup(`<div class="popup-title">Station STA-${s.id}</div>
          <div class="popup-row">Coords: <span>${fmtCoords(s.latitude, s.longitude)}</span></div>
          <div class="popup-row">Capacity: <span>${s.capacity} drones</span></div>`)
        .addTo(map);
      state.stationMarkers[s.id] = marker;
    }
  });
}

// ── RENDER FLEET ─────────────────────────────────────────────────────────────
function renderFleet() {
  const list = document.getElementById('fleet-list');
  const entries = Object.entries(state.drones);
  document.getElementById('fleet-count').textContent = entries.length;

  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">No fleet data</div>';
    return;
  }

  list.innerHTML = '';
  entries.forEach(([id, d]) => {
    const batt    = d.battery != null ? Math.round(d.battery) : 100;
    const battCls = batt > 60 ? 'high' : batt > 30 ? 'medium' : 'low';
    const status  = d.status || 'idle';

    const el = document.createElement('div');
    el.className = 'fleet-item';
    el.id = `fleet-${id}`;
    el.innerHTML = `
      <div class="fleet-drone-id">D${id}</div>
      <div class="fleet-info">
        <div class="fleet-status ${status}">${status.toUpperCase()}</div>
        <div class="fleet-coords">${d.lat != null ? fmtCoords(d.lat, d.lon) : 'At station'}</div>
      </div>
      <div class="battery-bar-wrap">
        <div class="battery-bar"><div class="battery-fill ${battCls}" style="width:${batt}%"></div></div>
        <div class="battery-pct">${batt}%</div>
      </div>
    `;
    list.appendChild(el);
  });
}

// ── RENDER INCIDENTS ─────────────────────────────────────────────────────────
function renderIncidents() {
  const list   = document.getElementById('incidents-list');
  const sorted = [...state.incidents].sort((a, b) => b.severity - a.severity);

  document.getElementById('incident-badge').textContent = sorted.length;
  document.getElementById('header-incident-count').textContent = sorted.length;

  if (!sorted.length) {
    list.innerHTML = '<div class="empty-state">No incidents detected</div>';
    return;
  }

  list.innerHTML = '';
  sorted.forEach(inc => {
    const sev     = inc.severity || 0;
    const sevCls  = severityClass(sev);
    const sevTxt  = sevCls.toUpperCase();
    const label   = getIncidentLabel(inc.incident_type);
    const el      = document.createElement('div');
    el.className  = `incident-item severity-${sevCls}`;
    el.dataset.id = inc.id;
    el.innerHTML  = `
      <div class="incident-header">
        <span class="incident-type">${label}</span>
        <span class="incident-severity-badge sev-${sevCls}">${sevTxt} · ${(sev * 10).toFixed(1)}</span>
      </div>
      <div class="incident-meta">
        <span class="incident-cam">${inc.camera_id || '–'}</span>
        <span class="incident-coords">${fmtCoords(inc.latitude, inc.longitude)}</span>
        <span class="incident-time">${formatTime(inc.timestamp)}</span>
        ${inc.dispatched ? '<span class="incident-dispatched">✓ Dispatched</span>' : ''}
      </div>
    `;

    el.addEventListener('click', () => openIncidentModal(inc));
    list.appendChild(el);

    // Map marker for incident
    if (!state.incidentMarkers[inc.id]) {
      const marker = L.marker([inc.latitude, inc.longitude], {icon: makeIncidentIcon(sev)})
        .bindPopup(`<div class="popup-title">⚠ ${label}</div>
          <div class="popup-row">Severity: <span>${(sev * 10).toFixed(1)}/10</span></div>
          <div class="popup-row">Camera: <span>${inc.camera_id}</span></div>
          <div class="popup-row">Confidence: <span>${inc.confidence ? (inc.confidence * 100).toFixed(0) + '%' : '?'}</span></div>
          <div class="popup-row">Time: <span>${formatTime(inc.timestamp)}</span></div>
          <div class="popup-row">Status: <span>${inc.dispatched ? '✓ Dispatched' : 'Pending'}</span></div>`)
        .addTo(map);
      state.incidentMarkers[inc.id] = marker;
    }
  });

  updateHeaders();
}

// ── RENDER PATHS ─────────────────────────────────────────────────────────────
function renderPaths() {
  const list = document.getElementById('paths-list');
  document.getElementById('paths-count').textContent = state.paths.length;

  if (!state.paths.length) {
    list.innerHTML = '<div class="empty-state">No active missions</div>';
    return;
  }

  list.innerHTML = '';
  state.paths.forEach(p => {
    const mission    = state.activeMissions[String(p.drone_id)] || {};
    const progress   = mission.progress != null ? Math.round(mission.progress * 100) : 0;
    const etaMin     = p.estimated_time ? Math.round(p.estimated_time / 60) : '?';
    const waypoints  = Array.isArray(p.waypoints) ? p.waypoints : [];

    const el = document.createElement('div');
    el.className = 'path-item';
    el.innerHTML = `
      <div class="path-header">
        <span class="path-drone-id">DRONE D${p.drone_id}</span>
        <span class="path-status">${progress >= 100 ? '✓ ARRIVED' : '↗ EN ROUTE'}</span>
      </div>
      <div class="path-progress-wrap">
        <div class="path-progress-bar">
          <div class="path-progress-fill" style="width:${progress}%"></div>
        </div>
        <div class="path-progress-label">${progress}% complete · ETA ~${etaMin}m</div>
      </div>
      <div class="path-stats">
        <div class="path-stat">Wpts: <span>${waypoints.length}</span></div>
        <div class="path-stat">Station: <span>${fmtCoords(p.station_lat, p.station_lon)}</span></div>
      </div>
    `;
    list.appendChild(el);

    // Draw path polyline on map
    if (waypoints.length >= 2 && !state.pathPolylines[p.id]) {
      const points = waypoints.map(wp => {
        const lat = wp.lat ?? wp.latitude;
        const lon = wp.lng ?? wp.lon ?? wp.longitude;
        return [lat, lon];
      }).filter(([lat, lon]) => lat != null && lon != null);

      if (points.length >= 2) {
        const poly = L.polyline(points, {
          color: '#00d4ff',
          weight: 2.5,
          opacity: 0.8,
          dashArray: '8, 4',
        }).addTo(map);
        state.pathPolylines[p.id] = poly;
      }
    }
  });

  updateHeaders();
}

// ── DRONE MAP MARKERS ────────────────────────────────────────────────────────
function updateDroneMarker(id, lat, lon, battery, status) {
  const busy = status === 'busy';

  if (!state.droneMarkers[id]) {
    const marker = L.marker([lat, lon], {icon: makeDroneIcon(busy)})
      .bindPopup(`<div class="popup-title">Drone D${id}</div>
        <div class="popup-row">Status: <span>${status || 'idle'}</span></div>
        <div class="popup-row">Battery: <span>${battery ? Math.round(battery) + '%' : '?%'}</span></div>
        <div class="popup-row">Position: <span>${fmtCoords(lat, lon)}</span></div>`)
      .addTo(map);
    state.droneMarkers[id] = marker;
  } else {
    state.droneMarkers[id].setLatLng([lat, lon]);
    state.droneMarkers[id].setIcon(makeDroneIcon(busy));
    state.droneMarkers[id].setPopupContent(
      `<div class="popup-title">Drone D${id}</div>
        <div class="popup-row">Status: <span>${status || 'idle'}</span></div>
        <div class="popup-row">Battery: <span>${battery ? Math.round(battery) + '%' : '?%'}</span></div>
        <div class="popup-row">Position: <span>${fmtCoords(lat, lon)}</span></div>`
    );
  }
}

// ── INCIDENT MODAL ───────────────────────────────────────────────────────────
function openIncidentModal(inc) {
  const backdrop = document.getElementById('modal-backdrop');
  const body     = document.getElementById('modal-body');
  const title    = document.getElementById('modal-title');
  const label    = getIncidentLabel(inc.incident_type);
  const sev      = inc.severity || 0;
  const sevCls   = severityClass(sev);

  title.textContent = `⚠ ${label}`;
  title.style.color = sevCls === 'high' ? 'var(--red)' : sevCls === 'medium' ? 'var(--amber)' : 'var(--blue)';

  body.innerHTML = `
    <div class="modal-field">
      <label>Incident ID</label>
      <div class="val">${inc.id?.slice(0, 12) || '–'}…</div>
    </div>
    <div class="modal-field">
      <label>Type</label>
      <div class="val">${label}</div>
    </div>
    <div class="modal-field">
      <label>Severity</label>
      <div class="val" style="color:var(--${sevCls === 'high' ? 'red' : sevCls === 'medium' ? 'amber' : 'blue'})">${(sev * 10).toFixed(2)} / 10</div>
    </div>
    <div class="modal-field">
      <label>Camera</label>
      <div class="val">${inc.camera_id || '–'}</div>
    </div>
    <div class="modal-field">
      <label>Confidence</label>
      <div class="val">${inc.confidence != null ? (inc.confidence * 100).toFixed(1) + '%' : '–'}</div>
    </div>
    <div class="modal-field">
      <label>Duration</label>
      <div class="val">${inc.duration != null ? inc.duration + 's' : '–'}</div>
    </div>
    <div class="modal-field full">
      <label>Coordinates</label>
      <div class="val">${fmtCoords(inc.latitude, inc.longitude)}</div>
    </div>
    <div class="modal-field">
      <label>Timestamp</label>
      <div class="val">${formatTime(inc.timestamp)}</div>
    </div>
    <div class="modal-field">
      <label>Status</label>
      <div class="val" style="color:${inc.dispatched ? 'var(--green)' : 'var(--amber)'}">${inc.dispatched ? '✓ Dispatched' : '⏳ Pending'}</div>
    </div>
  `;

  backdrop.classList.add('open');

  // Pan map to incident
  map.setView([inc.latitude, inc.longitude], 15);
  if (state.incidentMarkers[inc.id]) state.incidentMarkers[inc.id].openPopup();
}

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('modal-backdrop').classList.remove('open');
});
document.getElementById('modal-backdrop').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('open');
});

// ── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  const wsStatusEl = document.getElementById('ws-status');
  const wsLabel    = wsStatusEl.querySelector('span:last-child');

  try {
    state.ws = new WebSocket(WS_URL);
  } catch(e) {
    scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    state.wsConnected = true;
    wsStatusEl.classList.add('online');
    wsLabel.textContent = 'ONLINE';
    addLog('✅ WebSocket connected to AEGIS backend', 'success');
  };

  state.ws.onclose = () => {
    state.wsConnected = false;
    wsStatusEl.classList.remove('online');
    wsLabel.textContent = 'OFFLINE';
    addLog('⚠ WebSocket disconnected. Reconnecting…', 'warning');
    scheduleReconnect();
  };

  state.ws.onerror = () => {
    addLog('❌ WebSocket error', 'error');
  };

  state.ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); }
    catch { return; }
    handleWsEvent(msg.event, msg.data);
  };
}

function scheduleReconnect() {
  setTimeout(connectWS, 3000);
}

function handleWsEvent(event, data) {
  switch (event) {

    case 'new_alert': {
      // Push new incident to state
      const exists = state.incidents.find(i => i.id === data.id);
      if (!exists) {
        state.incidents.push(data);
        renderIncidents();
      }
      const label = getIncidentLabel(data.incident_type);
      addLog(`🚨 INCIDENT: ${label} at ${fmtCoords(data.latitude, data.longitude)} (sev ${(data.severity * 10).toFixed(1)})`, 'warning');
      break;
    }

    case 'drone_dispatched': {
      const droneId = String(data.drone_id);
      state.activeMissions[droneId] = {
        ...data,
        progress: 0,
      };
      // Update drone status in state
      if (state.drones[droneId]) {
        state.drones[droneId].status = 'busy';
      }
      // Draw planned path
      const waypoints = data.waypoints || [];
      if (waypoints.length >= 2 && showPaths) {
        const key    = `dispatch-${droneId}`;
        if (state.dronePathLines[key]) map.removeLayer(state.dronePathLines[key]);
        const points = waypoints.map(wp => {
          const lat = wp.lat ?? wp.latitude;
          const lon = wp.lng ?? wp.lon ?? wp.longitude;
          return [lat, lon];
        }).filter(([lat, lon]) => lat != null && lon != null);
        if (points.length >= 2) {
          state.dronePathLines[key] = L.polyline(points, {
            color: '#a855f7',
            weight: 2.5,
            opacity: 0.9,
            dashArray: '10, 5',
          }).addTo(map);
        }
      }
      renderFleet();
      renderStations();
      addLog(`🚁 DISPATCHED: Drone D${droneId} → Alert ${data.alert_id} (ETA ${Math.round(data.eta_seconds)}s)`, 'success');
      // Refresh incidents to reflect dispatched status
      fetchIncidents();
      break;
    }

    case 'live_telemetry': {
      const droneId = String(data.drone_id);
      const lat     = data.lat;
      const lon     = data.lon;

      if (!state.drones[droneId]) state.drones[droneId] = {};
      state.drones[droneId].lat     = lat;
      state.drones[droneId].lon     = lon;
      state.drones[droneId].status  = 'busy';
      if (data.battery != null) state.drones[droneId].battery = data.battery;

      if (state.activeMissions[droneId]) {
        state.activeMissions[droneId].progress = data.progress || 0;
      }

      // Move marker
      updateDroneMarker(droneId, lat, lon, state.drones[droneId].battery, 'busy');

      // Update fleet & paths silently (no full re-render — only targeted updates)
      const fleetItem = document.getElementById(`fleet-${droneId}`);
      if (fleetItem) {
        const batt     = state.drones[droneId].battery != null ? Math.round(state.drones[droneId].battery) : 100;
        const battCls  = batt > 60 ? 'high' : batt > 30 ? 'medium' : 'low';
        fleetItem.querySelector('.fleet-status').textContent = 'BUSY';
        fleetItem.querySelector('.fleet-coords').textContent = fmtCoords(lat, lon);
        fleetItem.querySelector('.battery-fill').className   = `battery-fill ${battCls}`;
        fleetItem.querySelector('.battery-fill').style.width = `${batt}%`;
        fleetItem.querySelector('.battery-pct').textContent  = `${batt}%`;
      }

      // Update mission progress bar
      if (state.activeMissions[droneId]) {
        const pct = Math.round((state.activeMissions[droneId].progress || 0) * 100);
        renderPaths(); // light enough, few paths expected
      }
      break;
    }

    case 'drone_arrived': {
      const droneId = String(data.drone_id);
      if (state.drones[droneId]) {
        state.drones[droneId].status = 'idle';
        state.drones[droneId].lat    = data.lat;
        state.drones[droneId].lon    = data.lon;
      }
      if (state.activeMissions[droneId]) {
        state.activeMissions[droneId].progress = 1;
      }
      updateDroneMarker(droneId, data.lat, data.lon, state.drones[droneId]?.battery, 'idle');
      addLog(`✅ ARRIVED: Drone D${droneId} at Alert ${data.alert_id}`, 'success');
      renderFleet();
      renderPaths();
      break;
    }

    case 'system_log': {
      const lvl = (data.level || 'info').toLowerCase();
      addLog(data.message, lvl === 'success' ? 'success' : lvl === 'warning' ? 'warning' : lvl === 'error' ? 'error' : 'info');
      break;
    }

    default:
      break;
  }
}

// ── INITIAL DATA FETCH ───────────────────────────────────────────────────────
async function fetchStations() {
  try {
    const res  = await fetch(`${API}/api/stations`);
    const json = await res.json();
    if (json.status === 'success') {
      state.stations = json.data || [];
      renderStations();
    }
  } catch (e) {
    addLog('⚠ Failed to fetch stations', 'error');
  }
}

async function fetchFleetState() {
  try {
    const res  = await fetch(`${API}/api/fleet_state`);
    const json = await res.json();
    if (json.status === 'success') {
      const data = json.data || {};
      // data is { droneId: { battery, lat, lon, ... } }
      Object.entries(data).forEach(([id, telemetry]) => {
        if (!state.drones[id]) state.drones[id] = {};
        Object.assign(state.drones[id], {
          lat:     telemetry.lat,
          lon:     telemetry.lon,
          battery: telemetry.battery,
          status:  telemetry.status || 'idle',
        });
        if (telemetry.lat != null && telemetry.lon != null) {
          updateDroneMarker(id, telemetry.lat, telemetry.lon, telemetry.battery, telemetry.status);
        }
      });
      renderFleet();
      updateHeaders();
    }
  } catch (e) {
    addLog('⚠ Failed to fetch fleet state', 'error');
  }
}

async function fetchIncidents() {
  try {
    const res  = await fetch(`${API}/api/incidents`);
    const json = await res.json();
    if (json.status === 'success') {
      state.incidents = json.data || [];
      renderIncidents();
    }
  } catch (e) {
    addLog('⚠ Failed to fetch incidents', 'error');
  }
}

async function fetchPaths() {
  try {
    const res  = await fetch(`${API}/api/paths`);
    const json = await res.json();
    if (json.status === 'success') {
      state.paths = json.data || [];
      renderPaths();
    }
  } catch (e) {
    addLog('⚠ Failed to fetch paths', 'error');
  }
}

// Periodic refresh of incidents & paths (every 10 seconds fallback)
setInterval(() => {
  fetchIncidents();
  fetchPaths();
}, 10_000);

// Refresh fleet state every 30s (telemetry is WS-driven, this is just a fallback)
setInterval(fetchFleetState, 30_000);

// ── BOOT ─────────────────────────────────────────────────────────────────────
async function boot() {
  addLog('Initialising AEGIS Command Dashboard…', 'info');
  addLog('Loading stations and fleet state…', 'info');

  await fetchStations();
  await fetchFleetState();
  await fetchIncidents();
  await fetchPaths();

  // Fit map to show all stations if available
  if (state.stations.length) {
    const pts = state.stations.map(s => [s.latitude, s.longitude]);
    try { map.fitBounds(L.latLngBounds(pts).pad(0.3)); } catch(e) {}
  }

  addLog('Connecting to live telemetry feed…', 'info');
  connectWS();
}

boot();
