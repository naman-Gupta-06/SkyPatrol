'use client';

// =============================================================================
// CCTVFeed.tsx
//
// Renders a realistic CCTV camera feed panel.
//
// BACKEND INTEGRATION:
//   The backend streams MP4 via GET /api/video/{filename}.
//   Set `src` to  "http://localhost:5001/api/video/input1.mp4"  and the
//   <video> element will handle range-request buffering automatically.
//
//   Example:
//     <CCTVFeed
//       id="cam-01"
//       label="CAM-01 / MG Road"
//       src="http://localhost:5001/api/video/input1.mp4"
//     />
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import { Camera, Wifi, WifiOff, AlertTriangle } from 'lucide-react';

interface CCTVFeedProps {
  id:     string;
  label:  string;
  src?:   string;   // Set to backend stream URL when available
  status?: 'live' | 'offline' | 'alert';
  incidentType?: string;
}

export default function CCTVFeed({
  id,
  label,
  src,
  status = 'live',
  incidentType,
}: CCTVFeedProps) {
  const videoRef          = useRef<HTMLVideoElement>(null);
  const canvasRef         = useRef<HTMLCanvasElement>(null);
  const [clock, setClock] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [fps, setFps]             = useState('30');
  const [videoError, setVideoError] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  // Live clock overlay
  useEffect(() => {
    setIsMounted(true);
    setFps((28 + Math.floor(Math.random() * 5)).toString());
    const tick = () => {
      const now = new Date();
      setClock(
        now.toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        })
      );
      setDateStr(
        now.toLocaleDateString('en-US', {
          year: '2-digit', month: '2-digit', day: '2-digit',
        })
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Static noise canvas (drawn once — gives the "CRT" feel)
  useEffect(() => {
    if (src || status !== 'offline') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx    = canvas.getContext('2d');
    if (!ctx) return;

    const drawNoise = () => {
      const { width, height } = canvas;
      const imageData = ctx.createImageData(width, height);
      for (let i = 0; i < imageData.data.length; i += 4) {
        const v = Math.random() * 30;
        imageData.data[i]     = v;
        imageData.data[i + 1] = v;
        imageData.data[i + 2] = v * 1.5;
        imageData.data[i + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
    };

    const id = setInterval(drawNoise, 100);
    return () => clearInterval(id);
  }, [src, status]);

  const statusMap = {
    live:    { color: '#00ff87', label: 'LIVE',    icon: <Wifi size={9} /> },
    offline: { color: '#ff3860', label: 'OFFLINE', icon: <WifiOff size={9} /> },
    alert:   { color: '#ffb300', label: 'ALERT',   icon: <AlertTriangle size={9} /> },
  };
  const st = statusMap[status];

  useEffect(() => {
    setVideoError(false);
  }, [src]);

  useEffect(() => {
    if (!src || !videoError) return undefined;
    const id = setInterval(() => {
      setVideoError(false);
    }, 4000);
    return () => clearInterval(id);
  }, [src, videoError]);

  return (
    <div
      id={id}
      className="glass-panel relative overflow-hidden flex flex-col"
      style={{ minHeight: '0' }}
    >
      {/* Corner decorations */}
      <div className="corner-tl" />
      <div className="corner-tr" />
      <div className="corner-bl" />
      <div className="corner-br" />

      {/* Header bar */}
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b flex-shrink-0"
        style={{ borderColor: 'rgba(0,245,255,0.1)' }}
      >
        <div className="flex items-center gap-2">
          <Camera size={12} className="text-cyber-cyan" />
          <span className="font-mono text-xs font-semibold text-white tracking-wide">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          {incidentType && status === 'alert' && (
            <span className="font-mono text-xs text-amber-400 uppercase tracking-widest">
              ⚠ {incidentType}
            </span>
          )}
          <div
            className="flex items-center gap-1 px-2 py-0.5 rounded"
            style={{
              background: `${st.color}14`,
              border:     `1px solid ${st.color}44`,
            }}
          >
            <span className="live-dot" style={{ color: st.color }}>{st.icon}</span>
            <span
              className="font-mono text-xs font-bold tracking-wider"
              style={{ color: st.color }}
            >
              {st.label}
            </span>
          </div>
        </div>
      </div>

      {/* Feed area */}
      <div className="relative flex-1 bg-black overflow-hidden" style={{ minHeight: '0' }}>
        {/* Background grid */}
        <div className="noise-grid absolute inset-0 opacity-40" />

        {src && !videoError ? (
          /* ── Live video stream from backend ─────────────────────────── */
          <video
            ref={videoRef}
            src={src}
            className="absolute inset-0 w-full h-full object-contain"
            autoPlay
            controls
            loop
            muted
            preload="auto"
            playsInline
            onCanPlay={(event) => {
              event.currentTarget.play().catch(() => {
                /* Browser autoplay policy can still require a user gesture. */
              });
            }}
            onLoadedData={() => setVideoError(false)}
            onError={() => setVideoError(true)}
          />
        ) : (
          /* ── Offline / placeholder mode ──────────────────────────────── */
          <>
            {status === 'offline' ? (
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full opacity-25"
                width={320}
                height={180}
              />
            ) : (
              /* Live but no URL yet — dark atmospheric placeholder */
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-12 h-12 rounded-full border border-cyan-500/20 flex items-center justify-center mx-auto mb-3"
                    style={{ background: 'rgba(0,245,255,0.04)' }}>
                    <Camera size={20} className="text-cyan-500/40" />
                  </div>
                  <div className="section-label text-slate-600">FEED INACTIVE</div>
                  <div className="font-mono text-xs text-slate-700 mt-1">
                    Set <code className="text-slate-500">src</code> to activate
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* CRT scanline */}
        <div className="cctv-scanline" />

        {/* Vignette */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.75) 100%)',
          }}
        />

        {/* ── HUD Overlays ────────────────────────────────────────────── */}

        {/* Top-left: timestamp */}
        <div className="absolute top-2 left-2 font-mono text-xs"
          style={{ color: 'rgba(0,245,255,0.7)', textShadow: '0 0 8px rgba(0,245,255,0.5)' }}>
          {isMounted ? `${dateStr} ${clock}` : ''}
        </div>

        {/* Top-right: FPS */}
        <div className="absolute top-2 right-2 font-mono text-xs text-slate-600">
          {isMounted ? `${fps} FPS` : ''}
        </div>

        {/* Bottom-left: resolution */}
        <div className="absolute bottom-2 left-2 font-mono text-xs text-slate-600">
          1920×1080 · H.264
        </div>

        {/* Bottom-right: blinking REC dot */}
        {status === 'live' && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
            <div className="live-dot w-2 h-2 rounded-full"
              style={{ background: '#ff3860', boxShadow: '0 0 6px #ff3860' }} />
            <span className="font-mono text-xs font-bold"
              style={{ color: '#ff3860', textShadow: '0 0 6px #ff3860' }}>REC</span>
          </div>
        )}

        {/* Alert overlay */}
        {status === 'alert' && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              border: '2px solid rgba(255,179,0,0.4)',
              boxShadow: 'inset 0 0 30px rgba(255,179,0,0.1)',
              animation: 'blink-live 2s ease-in-out infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}
