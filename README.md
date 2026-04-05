# 👁️ Heimdall | Autonomous Urban Watch System

![React](https://img.shields.io/badge/React-19.0-blue?style=for-the-badge&logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?style=for-the-badge&logo=typescript)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS-v4.0-38B2AC?style=for-the-badge&logo=tailwind-css)
![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?style=for-the-badge&logo=vite)
![Leaflet](https://img.shields.io/badge/React_Leaflet-5.0-199900?style=for-the-badge&logo=leaflet)

**Heimdall** is a closed-loop, AI-driven drone response system and dashboard for urban safety. It detects threats via CCTV, autonomously dispatches drones, and provides a real-time tactical map for operators—all with zero human latency.

---

## 📖 Table of Contents
- [System Architecture & Flow](#-system-architecture--flow)
- [Core Features](#-core-features)
- [Project Logic & Simulation](#-project-logic--simulation)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)

---

## 🗺️ System Architecture & Flow

Heimdall is designed as a Single Page Application (SPA) with a strict, secure routing flow. Here is exactly how a user navigates the system:

1. **The Public Landing Page (`/`)**
   - **Visuals:** Renders a cinematic 3D drone model (via GLTF/model-viewer) overlaid with custom animated spotlights and frosted glass UI.
   - **Purpose:** Acts as the public face of the system, explaining the core mission of autonomous threat response.

2. **System Authentication (`/login`)**
   - **Security:** A highly customized dark-mode login portal. It employs advanced frontend techniques (honeypot fields, name obfuscation) to block aggressive browser password suggestions, maintaining a strict tactical aesthetic.
   - **Flow:** Validates credentials via `authService`. On success, it issues a secure token to `localStorage` and routes the user to the protected dashboard.

3. **The Command Dashboard (`/dashboard`)**
   - **Protection:** Guarded by a `<ProtectedRoute>` component. If no token is found, intruders are bounced back to the login screen.
   - **The Hub:** The central nervous system of Heimdall. It features a fully resizable layout housing the tactical map, live CCTV feeds, drone fleet telemetry, and active incident logs.

---

## ✨ Core Features

* **Interactive Tactical Map:** Built with `react-leaflet` and Carto Dark tiles, featuring custom markers, live drone tracking, restricted No-Fly zones, and active incident coordinates.
* **Drone Fleet Telemetry:** Real-time simulation of drone battery life, status (idle, dispatch, returning), and geographical movement.
* **Live Surveillance Grid:** A CCTV component designed to ingest continuous video streams or mock placeholders of critical city sectors.
* **Timeline Logging:** An auto-scrolling, color-coded activity logger that records system initialized events, drone dispatches, and perimeter alerts every few seconds.
* **Resizable Command UI:** Utilizes `react-resizable-panels` to allow operators to expand the map or focus on camera feeds seamlessly without losing context.

---

## 🧠 Project Logic & Simulation

To demonstrate Heimdall's autonomous capabilities on the frontend, the project includes a custom physics and routing simulation layer:

### The Dispatch Loop
When an incident is flagged as `active`, the system assigns an available drone from the nearest `DRONE_CENTER`. 

### The Movement Engine (`App.tsx / MapComponent`)
A `useEffect` hook runs a `setInterval` every 1000ms (1 second). During each tick:
1. The engine checks the status of every drone in the fleet.
2. If a drone is `moving`, it calculates the Euclidean distance between its current `[lat, lng]` and its target `incident` coordinates.
3. It steps the drone's position closer to the target by a factor of `0.0002` degrees per tick.
4. It degrades the battery life mathematically.
5. *Future Backend Integration:* This frontend interpolation will be replaced by WebSocket streams feeding real `.geojson` / `alert_path.db` coordinates from the dispatch server.

---

## 🛠️ Tech Stack

This project uses bleeding-edge frontend tooling to ensure maximum performance and developer experience:

* **Framework:** [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
* **Bundler:** [Vite 6](https://vitejs.dev/) (Ultra-fast HMR)
* **Styling:** [Tailwind CSS v4](https://tailwindcss.com/) (Using the new `@theme` engine in `index.css`)
* **Routing:** [React Router 7](https://reactrouter.com/)
* **Map Engine:** [Leaflet](https://leafletjs.com/) & [React-Leaflet](https://react-leaflet.js.org/)
* **UI Components:** [Radix UI](https://www.radix-ui.com/) + [Lucide React](https://lucide.dev/) (Icons)
* **Layouts:** `react-resizable-panels`

---

## 📂 Project Structure

```text
src/
├── components/
│   ├── ui/               # Reusable base components (Buttons, Inputs, Cards)
│   ├── CCTVFeed.tsx      # Video feed containers
│   ├── MapComponent.tsx  # Leaflet map wrapper and overlays
│   ├── ProtectedRoute.tsx# Router security wrapper
│   └── TimelineLogs.tsx  # Auto-scrolling event logger
├── lib/
│   └── utils.ts          # Tailwind merge (cn) utility
├── pages/
│   ├── Landing.tsx       # 3D Hero scene and entry point
│   ├── Login.tsx         # Heimdall authentication portal
│   └── Dashboard.tsx     # Main application wrapper and simulation loop
├── services/
│   └── auth.ts           # Mock/Real authentication handling
├── types/
│   └── index.ts          # TypeScript interfaces (Drone, Incident, LogEntry)
├── App.tsx               # Root React Router setup
├── constants.ts          # Mock data (PUNE_CENTER, INITIAL_DRONES, etc.)
└── index.css             # Tailwind v4 theme variables and global resets
