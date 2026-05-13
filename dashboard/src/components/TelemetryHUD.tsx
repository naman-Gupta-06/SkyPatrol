'use client';

import { Gauge, Battery, Navigation, ArrowUp, Wifi, WifiOff } from 'lucide-react';

interface TelemetryHUDProps {
  progress:     number;  // 0 – 1
  lat:          number;
  lon:          number;
  wpIdx:        number;
  wpTotal:      number;
  droneId:      string;
  status:       'idle' | 'dispatched' | 'arrived' | 'returning';
  etaSeconds:   number;
  battery?:      number;
  returnProgress?: number;
  // Live backend values (optional — fall back to simulated when offline)
  liveAltitude?: number;
  liveSpeed?:    number;
  wsConnected:   boolean;
  activeMissionCount?: number;
}

export default function TelemetryHUD({
  progress, lat, lon, wpIdx, wpTotal, droneId, status, etaSeconds,
  battery: liveBattery, returnProgress = 0,
  liveAltitude, liveSpeed, wsConnected, activeMissionCount = 0,
}: TelemetryHUDProps) {
  const pct = Math.round(progress * 100);
  const returnPct = Math.round(returnProgress * 100);

  // Use live values when backend connected, simulated otherwise
  const speed = liveSpeed   != null
    ? liveSpeed.toFixed(1)
    : status === 'dispatched' ? (50 + Math.sin(progress * Math.PI * 4) * 5).toFixed(1) : '0.0';

  const altitude = liveAltitude != null
    ? liveAltitude
    : status === 'dispatched' ? Math.round(40 + Math.sin(progress * Math.PI * 3) * 35) : 0;

  const battery      = Math.round(liveBattery ?? Math.max(78 - Math.round(progress * 30), 20));
  const remainingEta = Math.max(
    0,
    Math.round(etaSeconds * (status === 'returning' ? (1 - returnProgress) : (1 - progress))),
  );

  const statusColor = {
    idle:       { color: '#ffb300', bg: 'rgba(255,179,0,0.1)',   border: 'rgba(255,179,0,0.25)'   },
    dispatched: { color: '#00ff87', bg: 'rgba(0,255,135,0.08)', border: 'rgba(0,255,135,0.25)'  },
    arrived:    { color: '#00d4ff', bg: 'rgba(0,212,255,0.08)', border: 'rgba(0,212,255,0.25)'  },
    returning:  { color: '#ffb300', bg: 'rgba(255,179,0,0.08)', border: 'rgba(255,179,0,0.25)'  },
  }[status];

  return (
    <div className="glass-panel px-4 py-3 flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge size={14} className="text-cyber-cyan" />
          <span className="font-mono text-xs font-semibold text-white tracking-widest">
            TELEMETRY · {droneId}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="font-mono text-xs font-bold px-2 py-0.5 rounded"
            style={{ color: '#94a3b8', background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.18)' }}>
            {activeMissionCount} ACTIVE
          </div>
          {/* Connection mode badge */}
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded"
            style={{
              background: wsConnected ? 'rgba(0,255,135,0.08)' : 'rgba(255,179,0,0.08)',
              border: `1px solid ${wsConnected ? 'rgba(0,255,135,0.2)' : 'rgba(255,179,0,0.2)'}`,
            }}>
            {wsConnected
              ? <Wifi    size={9} className="text-cyber-green" />
              : <WifiOff size={9} className="text-amber-400"   />}
            <span className="font-mono ml-1"
              style={{ fontSize: '0.5rem', color: wsConnected ? '#00ff87' : '#ffb300' }}>
              {wsConnected ? 'LIVE' : 'SIM'}
            </span>
          </div>
          {/* Status badge */}
          <div className="font-mono text-xs font-bold px-2 py-0.5 rounded"
            style={{ color: statusColor.color, background: statusColor.bg, border: `1px solid ${statusColor.border}` }}>
            {status.toUpperCase()}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between items-center mb-1">
          <span className="section-label">{status === 'returning' ? 'ROUTE COMPLETE / RETURNING' : 'ROUTE PROGRESS'}</span>
          <span className="font-mono text-xs text-cyber-cyan font-bold">
            {status === 'returning' ? `RTB ${returnPct}%` : `${pct}%`}
          </span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(0,245,255,0.1)' }}>
          <div className="h-full rounded-full transition-all duration-500"
            style={{
              width:      `${pct}%`,
              background: 'linear-gradient(90deg, rgba(0,245,255,0.4), #00f5ff)',
              boxShadow:  '0 0 8px rgba(0,245,255,0.5)',
            }} />
        </div>
        <div className="flex justify-between mt-1">
          <span className="section-label">WP {wpIdx + 1} / {wpTotal}</span>
          <span className="section-label">ETA {remainingEta}s</span>
        </div>
        {status === 'returning' && (
          <div className="mt-2">
            <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,179,0,0.12)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${returnPct}%`,
                  background: 'linear-gradient(90deg, rgba(255,179,0,0.35), #ffb300)',
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <StatBox icon={<Navigation size={12} />} label="SPEED"    value={`${speed} km/h`}  color="cyan"  />
        <StatBox icon={<ArrowUp    size={12} />} label="ALTITUDE" value={`${altitude} m`}   color="cyan"  />
        <StatBox icon={<Battery    size={12} />} label="BATTERY"
          value={`${battery}%`}
          color={battery > 50 ? 'green' : battery > 25 ? 'amber' : 'red'} />
        <StatBox icon={<Wifi size={12} />} label="SIGNAL"
          value={wsConnected ? '●  LIVE' : '○ SIM'}
          color={wsConnected ? 'green' : 'amber'} />
      </div>

      {/* GPS readout */}
      <div className="rounded-md px-3 py-2"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(0,245,255,0.08)' }}>
        <div className="section-label mb-1">
          {wsConnected ? '🔴 LIVE GPS' : '⚪ SIMULATED GPS'}
        </div>
        <div className="font-mono text-xs text-cyber-cyan">
          {lat.toFixed(6)}°N &nbsp; {lon.toFixed(6)}°E
        </div>
        {wsConnected && (
          <div className="font-mono text-xs text-slate-500 mt-0.5">
            ALT {altitude} m &nbsp; SPD {speed} km/h
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string;
  color: 'cyan' | 'amber' | 'green' | 'red';
}) {
  const map = {
    cyan:  { text: 'text-cyber-cyan',  bg: 'rgba(0,245,255,0.05)',  border: 'rgba(0,245,255,0.12)'  },
    amber: { text: 'text-amber-400',   bg: 'rgba(255,179,0,0.05)',  border: 'rgba(255,179,0,0.12)'  },
    green: { text: 'text-cyber-green', bg: 'rgba(0,255,135,0.05)', border: 'rgba(0,255,135,0.12)'  },
    red:   { text: 'text-cyber-red',   bg: 'rgba(255,56,96,0.05)', border: 'rgba(255,56,96,0.12)'  },
  };
  const c = map[color];
  return (
    <div className="rounded-md px-3 py-2 flex items-center gap-2"
      style={{ background: c.bg, border: `1px solid ${c.border}` }}>
      <span className={c.text}>{icon}</span>
      <div>
        <div className="section-label" style={{ fontSize: '0.5rem' }}>{label}</div>
        <div className={`font-mono text-xs font-bold ${c.text}`}>{value}</div>
      </div>
    </div>
  );
}
