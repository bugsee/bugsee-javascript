import { Component, OnDestroy, OnInit, signal } from '@angular/core';

/**
 * A real (if small) feature: a live "expense activity" feed over a WebSocket to the local API server —
 * every browser tab open on the app sees every create/approve/reject in real time. Also exercises S7's
 * WebSocket capture path with genuine bidirectional traffic (not a synthetic ping).
 */
@Component({
  selector: 'app-activity-feed',
  standalone: true,
  template: `
    <h4 style="margin-bottom: 4px;">
      Activity feed
      <span [style.color]="connected() ? '#16a34a' : '#dc2626'" style="font-size: 11px;">
        {{ connected() ? 'connected' : 'disconnected' }}
      </span>
    </h4>
    <ul class="activity-feed" data-testid="activity-feed">
      @for (m of messages(); track $index) {
        <li>{{ m }}</li>
      }
    </ul>
  `,
})
export class ActivityFeedComponent implements OnInit, OnDestroy {
  readonly messages = signal<string[]>([]);
  readonly connected = signal(false);
  #ws?: WebSocket;

  ngOnInit(): void {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/ws`);
    this.#ws = ws;
    ws.onopen = () => this.connected.set(true);
    ws.onclose = () => this.connected.set(false);
    ws.onmessage = (event) => {
      this.messages.update((prev) => [...prev.slice(-19), String(event.data)]);
    };
  }

  ngOnDestroy(): void {
    this.#ws?.close();
  }
}
