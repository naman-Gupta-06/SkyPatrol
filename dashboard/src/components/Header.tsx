'use client';

import { useEffect, useState } from 'react';
import { Shield, Wifi, WifiOff, Activity, Clock, Zap } from 'lucide-react';

interface HeaderProps {
  droneStatus:    'idle' | 'dispatched' | 'arrived' | 'returning';
  activeMissions: number;
  wsConnected:    boolean;
  totalDrones:     number;
}

export default function Header({ droneStatus, activeMissions, wsConnected, totalDrones }: HeaderProps) {
  const [time, setTime] = useState('');
  const [date, setDate] = useState('');

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
      setDate(now.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const statusMap = {
    idle:       { label: 'STANDBY', color: 'green' as const },
    dispatched: { label: 'ACTIVE',  color: 'green' as const },
    arrived:    { label: 'ARRIVED', color: 'cyan'  as const },
    returning:  { label: 'RETURNING', color: 'amber' as const },
  };
  const s = statusMap[droneStatus];

  return (
    <header className="relative glass-panel mx-3 mt-3 px-5 py-3 flex items-center justify-between overflow-hidden">
      <div className="corner-tl" /><div className="corner-tr" />
      <div className="corner-bl" /><div className="corner-br" />
      {/* Top accent line */}
      <div className="absolute top-0 left-0 right-0 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(0,245,255,0.6) 40%, rgba(0,245,255,0.6) 60%, transparent)' }} />

      {/* Left: Logo */}
      <div className="flex items-center gap-3">
        <div className="relative w-9 h-9 rounded-lg flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, rgba(0,245,255,0.15), rgba(0,245,255,0.05))', border: '1px solid rgba(0,245,255,0.3)' }}>
          <Shield size={18} className="text-cyber-cyan text-glow-cyan" />
        </div>
        <div>
          <h1 className="text-base font-bold tracking-widest text-white font-mono">
            HEIMDALL
            <span className="text-cyber-cyan text-glow-cyan ml-2 text-xs font-normal">v2.1</span>
          </h1>
          <p className="section-label" style={{ color: 'rgba(0,245,255,0.45)' }}>
            Drone Dispatch &amp; Incident Monitoring
          </p>
        </div>
      </div>

      {/* Center: stats */}
      <div className="hidden md:flex items-center gap-4">
        <StatPill icon={<Activity size={13} />} label="ACTIVE MISSIONS" value={String(activeMissions)} color="cyan" />
        <StatPill icon={<Zap size={13} />} label="FLEET DRONES" value={String(totalDrones)} color="amber" />
        <StatPill icon={<Zap size={13} />} label="FLEET STATUS" value={s.label} color={s.color} />

        {/* Backend connection — real status */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-md"
          style={{
            border:     `1px solid ${wsConnected ? 'rgba(0,255,135,0.25)' : 'rgba(255,56,96,0.25)'}`,
            background: wsConnected ? 'rgba(0,255,135,0.06)' : 'rgba(255,56,96,0.06)',
          }}
        >
          {wsConnected
            ? <Wifi    size={13} className="text-cyber-green" />
            : <WifiOff size={13} className="text-cyber-red"   />}
          <div>
            <div className="section-label" style={{ fontSize: '0.55rem' }}>BACKEND</div>
            <div
              className="font-mono text-xs font-bold"
              style={{ color: wsConnected ? '#00ff87' : '#ff3860' }}
            >
              {wsConnected ? 'CONNECTED' : 'OFFLINE'}
            </div>
          </div>
          {wsConnected && (
            <div className="live-dot w-1.5 h-1.5 rounded-full ml-1"
              style={{ background: '#00ff87', boxShadow: '0 0 4px #00ff87' }} />
          )}
        </div>
      </div>

      {/* Right: Clock */}
      <div className="flex items-center gap-3">
        <div className="text-right">
          <div className="flex items-center gap-2 justify-end">
            <Clock size={12} className="text-cyber-cyan opacity-60" />
            <span className="font-mono text-lg font-bold text-white tracking-wider">{time}</span>
          </div>
          <div className="font-mono text-xs text-slate-500 text-right mt-0.5">{date}</div>
        </div>
        <div className="relative flex items-center justify-center w-7 h-7">
          <div className="w-2.5 h-2.5 rounded-full bg-cyber-green status-ring" />
        </div>
      </div>
    </header>
  );
}

function StatPill({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string;
  color: 'cyan' | 'amber' | 'green' | 'red';
}) {
  const map = {
    cyan:  { text: 'text-cyber-cyan',  border: 'rgba(0,245,255,0.2)',  bg: 'rgba(0,245,255,0.05)'  },
    amber: { text: 'text-amber-400',   border: 'rgba(255,179,0,0.2)',  bg: 'rgba(255,179,0,0.05)'  },
    green: { text: 'text-cyber-green', border: 'rgba(0,255,135,0.2)', bg: 'rgba(0,255,135,0.05)' },
    red:   { text: 'text-cyber-red',   border: 'rgba(255,56,96,0.2)', bg: 'rgba(255,56,96,0.05)' },
  };
  const c = map[color];
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md"
      style={{ border: `1px solid ${c.border}`, background: c.bg }}>
      <span className={c.text}>{icon}</span>
      <div>
        <div className="section-label" style={{ fontSize: '0.55rem' }}>{label}</div>
        <div className={`font-mono text-xs font-bold ${c.text}`}>{value}</div>
      </div>
    </div>
  );
}
