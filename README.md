# Heimdall Local Run

Start the backend first:

```powershell
.\scripts\start_backend.ps1
```

Then start the dashboard:

```powershell
cd dashboard
npm run dev
```

The dashboard reads `dashboard/.env.local` and connects to:

- REST API: `http://127.0.0.1:5001`
- WebSocket: `ws://127.0.0.1:5001/ws`
- Frontend: `http://localhost:3000`

The backend pipeline is:

1. `media/input1.mp4`, `media/input2.mp4`, and `media/input3.mp4` run through the detector.
2. A detector alert is inserted once per active camera/video signal.
3. The priority loop evaluates every station, uses the pathfinder when available, selects the closest station with an available drone, saves one winning path, and broadcasts the dispatch.
4. The frontend receives the dispatch path over WebSocket and draws the route, live drone telemetry, incident queue, CCTV streams, and restricted zones.
