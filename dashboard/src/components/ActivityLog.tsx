'use client';

// =============================================================================
// ActivityLog.tsx  —  Live + Simulated activity log
//
// LIVE MODE  (wsConnected=true):
//   Displays `externalLogs` pushed from parent (sourced from WS system_log
//   events).  The 3s mock-telemetry interval is suppressed — real backend
//   events dominate.  Positional ticker still fires for GPS readout updates.
//
// SIM MODE  (wsConnected=false):
//   The 3s interval generates mock log entries using drone GPS from props.
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal, ChevronRight, Radio, Wifi, WifiOff } from 'lucide-react';
import { LOG_TEMPLATES } from '@/lib/mockData';
import { WS_URL } from '@/lib/backend';
import type { ExternalLog } from '@/lib/mockData';

interface LogEntry {
  id:        number;
  timestamp: string;
  message:   string;
  level:     'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
}

interface ActivityLogProps {
  droneId:       string;
  droneLat:     number;
  droneLon:     number;
  waypointIdx:  number;
  droneStatus:  'idle' | 'dispatched' | 'arrived' | 'returning';
  wsConnected:  boolean;
  externalLogs: ExternalLog[];
}

let idCtr = 0;
function mkEntry(msg: string, level: LogEntry['level'] = 'INFO'): LogEntry {
  return {
    id: ++idCtr,
    timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
    message:   msg,
    level,
  };
}

const MAX_LOGS = 100;

export default function ActivityLog({
  droneId, droneLat, droneLon, waypointIdx, droneStatus, wsConnected, externalLogs,
}: ActivityLogProps) {
  const displayDroneId = droneId.startsWith('D') ? droneId : `D${droneId}`;
  const [internalLogs, setInternalLogs] = useState<LogEntry[]>([]);
  const bottomRef    = useRef<HTMLDivElement>(null);
  const templateIdx  = useRef(0);

  // Populate initial entries only on client to avoid hydration mismatch
  useEffect(() => {
    setInternalLogs([
      mkEntry('🟢 System online — Heimdall dashboard initialised', 'SUCCESS'),
      mkEntry(`Connecting to ${WS_URL}...`, 'INFO'),
      mkEntry('🗺  Map subsystem loaded — tactical grid active', 'INFO'),
      mkEntry('🚁 Drone Alpha (D-01) awaiting dispatch', 'INFO'),
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep refs current so interval closure is always fresh
  const wpRef     = useRef(waypointIdx);
  const latRef    = useRef(droneLat);
  const lonRef    = useRef(droneLon);
  const statusRef = useRef(droneStatus);
  const wsRef     = useRef(wsConnected);
  useEffect(() => { wpRef.current     = waypointIdx;  }, [waypointIdx]);
  useEffect(() => { latRef.current    = droneLat;     }, [droneLat]);
  useEffect(() => { lonRef.current    = droneLon;     }, [droneLon]);
  useEffect(() => { statusRef.current = droneStatus;  }, [droneStatus]);
  useEffect(() => { wsRef.current     = wsConnected;  }, [wsConnected]);

  const appendInternal = useCallback((entry: LogEntry) => {
    setInternalLogs(prev => {
      const next = [...prev, entry];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  }, []);

  // Auto-scroll
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [internalLogs, externalLogs]);

  // 3 s positional ticker — runs always but labels source correctly
  useEffect(() => {
    const id = setInterval(() => {
      if (statusRef.current === 'idle') return;
      const lat  = latRef.current.toFixed(5);
      const lon  = lonRef.current.toFixed(5);
      const wp   = wpRef.current + 1;
      const tmpl = LOG_TEMPLATES[templateIdx.current % LOG_TEMPLATES.length];
      templateIdx.current++;
      const prefix = wsRef.current ? '📡 ' : '🔄 ';
      appendInternal(mkEntry(prefix + tmpl(wp, lat, lon).replace(/^[^\s]+\s/, ''), 'INFO'));
    }, 3000);
    return () => clearInterval(id);
  }, [appendInternal]);

  // Status-change log entries
  const prevStatus = useRef(droneStatus);
  useEffect(() => {
    if (droneStatus === prevStatus.current) return;
    prevStatus.current = droneStatus;
    if (droneStatus === 'dispatched') {
      appendInternal(mkEntry('🚨 DISPATCH TRIGGERED — Drone en route to incident', 'WARNING'));
    } else if (droneStatus === 'arrived') {
      appendInternal(mkEntry('✅ ARRIVED — Drone reached incident site. Hovering…', 'SUCCESS'));
    } else if (droneStatus === 'returning') {
      appendInternal(mkEntry('RETURNING - Drone heading back to station', 'INFO'));
    } else {
      appendInternal(mkEntry('🔄 Drone returning to idle — awaiting next dispatch', 'INFO'));
    }
  }, [droneStatus, appendInternal]);

  // WS connect/disconnect log entry
  const prevWs = useRef(wsConnected);
  useEffect(() => {
    if (wsConnected === prevWs.current) return;
    prevWs.current = wsConnected;
    if (wsConnected) {
      appendInternal(mkEntry('🔌 Backend WebSocket connected — switching to live telemetry', 'SUCCESS'));
    } else {
      appendInternal(mkEntry('⚠️  WebSocket lost — falling back to simulation mode', 'WARNING'));
    }
  }, [wsConnected, appendInternal]);

  // Merge internal + externalLogs, sort by id desc for latest-at-bottom
  const allLogs: LogEntry[] = [
    ...internalLogs,
    ...externalLogs,
  ]
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_LOGS);

  const levelStyle: Record<LogEntry['level'], { text: string; bar: string; bg: string }> = {
    INFO:    { text: 'text-slate-400',   bar: 'bg-slate-600',    bg: 'hover:bg-slate-800/30' },
    SUCCESS: { text: 'text-cyber-green', bar: 'bg-cyber-green',  bg: 'hover:bg-green-900/20' },
    WARNING: { text: 'text-amber-400',   bar: 'bg-amber-400',    bg: 'hover:bg-amber-900/20' },
    ERROR:   { text: 'text-cyber-red',   bar: 'bg-red-600',      bg: 'hover:bg-red-900/20'   },
  };

  return (
    <div className="glass-panel flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: 'rgba(0,245,255,0.1)' }}>
        <div className="flex items-center gap-2">
          <Terminal size={15} className="text-cyber-cyan" />
          <span className="font-mono text-sm font-semibold text-white tracking-wide">ACTIVITY LOG</span>
        </div>
        <div className="flex items-center gap-2">
          {wsConnected
            ? <><div className="live-dot w-2 h-2 rounded-full bg-cyber-green" />
                <span className="section-label text-cyber-green">LIVE</span>
                <Wifi size={10} className="text-cyber-green ml-1" /></>
            : <><WifiOff size={10} className="text-amber-400" />
                <span className="section-label text-amber-400">SIM</span></>}
          <span className="ml-1 font-mono text-xs px-2 py-0.5 rounded"
            style={{ background: 'rgba(0,245,255,0.08)', border: '1px solid rgba(0,245,255,0.15)', color: 'rgba(0,245,255,0.7)' }}>
            {allLogs.length}
          </span>
        </div>
      </div>

      {/* GPS status bar */}
      <div className="px-4 py-2 border-b flex items-center gap-3"
        style={{ borderColor: 'rgba(0,245,255,0.06)', background: 'rgba(0,245,255,0.03)' }}>
        <Radio size={12} className="text-cyber-cyan animate-pulse" />
        <div className="font-mono text-xs text-slate-300 truncate">
          <span className="text-slate-500">{displayDroneId} </span>
          <span className="text-cyber-cyan">{droneLat.toFixed(5)}°N, {droneLon.toFixed(5)}°E</span>
          <span className="text-slate-500 ml-2">WP-{waypointIdx + 1}</span>
        </div>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5">
        {allLogs.map((entry) => {
          const sty = levelStyle[entry.level] ?? levelStyle.INFO;
          return (
            <div key={entry.id}
              className={`log-entry flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors ${sty.bg}`}>
              <div className={`w-0.5 self-stretch rounded-full mt-0.5 flex-shrink-0 ${sty.bar}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <ChevronRight size={9} className="text-slate-600 flex-shrink-0" />
                  <span className="font-mono text-xs text-slate-500">{entry.timestamp}</span>
                </div>
                <p className={`font-mono text-xs leading-relaxed break-words ${sty.text}`}>{entry.message}</p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Footer prompt */}
      <div className="px-4 py-2 border-t flex items-center gap-2"
        style={{ borderColor: 'rgba(0,245,255,0.1)' }}>
        <span className="text-cyber-cyan font-mono text-xs">heimdall@sys $</span>
        <span className="w-1.5 h-4 bg-cyber-cyan opacity-70 animate-pulse inline-block rounded-sm" />
      </div>
    </div>
  );
}
