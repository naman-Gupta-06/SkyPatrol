// =============================================================================
// src/lib/websocket.ts
//
// WebSocket client for the FastAPI backend.
// Connect once at app level. Incoming events will drive global state updates.
// =============================================================================

export type WsEventName =
  | 'new_alert'
  | 'drone_dispatched'
  | 'live_telemetry'
  | 'drone_arrived'
  | 'system_log';

export interface WsMessage {
  event: WsEventName;
  data: Record<string, unknown>;
}

type Handler = (data: Record<string, unknown>) => void;

class HeimdallWsClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Handler[]> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(url: string = WS_URL) {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(url);

    this.ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);
        this.handlers.get(msg.event)?.forEach((h) => h(msg.data));
      } catch {
        /* ignore malformed frames */
      }
    };

    this.ws.onclose = () => {
      this.reconnectTimer = setTimeout(() => this.connect(url), 3000);
    };
  }

  on(event: WsEventName, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((h) => h !== handler)
      );
    };
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

// Singleton — import and call .connect() once in _app or layout.
export const wsClient = new HeimdallWsClient();
import { WS_URL } from './backend';
