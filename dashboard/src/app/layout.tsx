import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Heimdall — Drone Dispatch & Incident Monitoring',
  description:
    'Real-time drone dispatch and incident monitoring dashboard. Live telemetry, AI-detected incident tracking, and smart fleet management.',
  keywords: 'drone, dispatch, monitoring, incident, real-time, dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Leaflet CSS — loaded via CDN so bundle/SSR never interferes */}
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
          crossOrigin=""
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
