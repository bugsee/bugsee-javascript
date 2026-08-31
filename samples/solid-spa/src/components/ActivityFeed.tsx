import { For, createSignal, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';

/**
 * A real (if small) feature: a live "issue activity" feed over a WebSocket to the local API server —
 * every browser tab open on the tracker sees every other tab's issue/comment activity in real time.
 * Also exercises S7's WebSocket capture path with genuine bidirectional traffic (not a synthetic
 * ping).
 */
export default function ActivityFeed(): JSX.Element {
  const [messages, setMessages] = createSignal<string[]>([]);
  const [connected, setConnected] = createSignal(false);

  onMount(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/ws`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      setMessages((prev) => [...prev.slice(-19), String(event.data)]);
    };
    onCleanup(() => ws.close());
  });

  return (
    <div>
      <h4 style={{ 'margin-bottom': '4px' }}>
        Activity feed{' '}
        <span style={{ 'font-size': '11px', color: connected() ? '#16a34a' : '#dc2626' }}>
          {connected() ? 'connected' : 'disconnected'}
        </span>
      </h4>
      <ul class="activity-feed" data-testid="activity-feed">
        <For each={messages()}>{(m) => <li>{m}</li>}</For>
      </ul>
    </div>
  );
}
