import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface ActivityFeedHandle {
  broadcast: (message: string) => void;
}

/**
 * A real (if small) feature: a live "board activity" feed over a WebSocket to the local API server —
 * every browser tab open on the board sees every other tab's card moves/creates in real time. Also
 * exercises S7's WebSocket capture path with genuine bidirectional traffic (not a synthetic ping).
 */
const ActivityFeed = forwardRef<ActivityFeedHandle>(function ActivityFeed(_props, ref) {
  const [messages, setMessages] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/ws`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      setMessages((prev) => [...prev.slice(-19), String(event.data)]);
    };
    return () => ws.close();
  }, []);

  useImperativeHandle(ref, () => ({
    broadcast: (message: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(message);
    },
  }));

  return (
    <div>
      <h4 style={{ marginBottom: 4 }}>
        Activity feed <span style={{ fontSize: 11, color: connected ? '#16a34a' : '#dc2626' }}>
          {connected ? 'connected' : 'disconnected'}
        </span>
      </h4>
      <ul className="activity-feed" data-testid="activity-feed">
        {messages.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
});

export default ActivityFeed;
