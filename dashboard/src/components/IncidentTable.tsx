'use client';

import { AlertTriangle, Clock, Eye, MapPin } from 'lucide-react';
import type { Incident } from '@/lib/mockData';

interface IncidentTableProps {
  incidents: Incident[];
}

const typeLabels: Record<string, string> = {
  accident: 'ACC',
  crowd: 'CRD',
  fire: 'FIR',
  theft: 'SEC',
};

const statusStyle = {
  pending: { text: '#ffb300', bg: 'rgba(255,179,0,0.1)', border: 'rgba(255,179,0,0.3)' },
  dispatched: { text: '#00ff87', bg: 'rgba(0,255,135,0.08)', border: 'rgba(0,255,135,0.3)' },
  observed: { text: '#38bdf8', bg: 'rgba(56,189,248,0.08)', border: 'rgba(56,189,248,0.24)' },
  ignored: { text: '#64748b', bg: 'rgba(100,116,139,0.1)', border: 'rgba(100,116,139,0.2)' },
};

export default function IncidentTable({ incidents }: IncidentTableProps) {
  const pendingCount = incidents.filter((incident) => incident.status === 'pending').length;

  return (
    <div className="ops-panel flex h-full flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-700/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-400" />
          <span className="font-mono text-xs font-semibold tracking-wide text-white">INCIDENT QUEUE</span>
        </div>
        <span
          className="rounded px-2 py-0.5 font-mono text-xs"
          style={{ background: 'rgba(255,179,0,0.1)', border: '1px solid rgba(255,179,0,0.25)', color: '#ffb300' }}
        >
          {pendingCount} PENDING
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {incidents.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <Eye size={24} className="mx-auto mb-2 text-slate-700" />
              <p className="section-label">NO INCIDENTS</p>
            </div>
          </div>
        ) : (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-slate-700/40">
                {['TYPE', 'SEVERITY', 'LOCATION', 'TIME', 'STATUS'].map((heading) => (
                  <th key={heading} className="px-3 py-2 text-left text-[0.55rem] font-normal tracking-widest text-slate-500">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {incidents.map((incident, index) => {
                const style = statusStyle[incident.status] ?? statusStyle.ignored;
                return (
                  <tr
                    key={incident.id}
                    className="border-b border-white/[0.03] transition-colors hover:bg-cyan-400/[0.04]"
                    style={{
                      background: index % 2 === 0 ? 'rgba(148,163,184,0.025)' : 'transparent',
                      opacity: incident.status === 'observed' ? 0.48 : 1,
                    }}
                  >
                    <td className="px-3 py-2 text-white">
                      <span className="mr-2 rounded border border-slate-600 px-1 py-0.5 text-[10px] text-slate-300">
                        {typeLabels[incident.incident_type] ?? 'UNK'}
                      </span>
                      <span className="capitalize">{incident.incident_type}</span>
                    </td>
                    <td className="px-3 py-2">
                      <SeverityBar value={incident.severity} />
                    </td>
                    <td className="px-3 py-2 text-slate-400">
                      <span className="flex items-center gap-1">
                        <MapPin size={9} />
                        {incident.latitude.toFixed(3)}, {incident.longitude.toFixed(3)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500">
                      <span className="flex items-center gap-1">
                        <Clock size={9} />
                        {new Date(incident.timestamp).toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: true,
                        })}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="rounded px-1.5 py-0.5 text-[0.5rem] font-bold uppercase tracking-wider"
                        style={{ color: style.text, background: style.bg, border: `1px solid ${style.border}` }}
                      >
                        {incident.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SeverityBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value > 0.7 ? '#ff3860' : value > 0.45 ? '#ffb300' : '#00ff87';

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ color }}>{pct}%</span>
    </div>
  );
}
