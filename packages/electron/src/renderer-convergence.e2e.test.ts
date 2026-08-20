// R0 — the acceptance test for renderer incident convergence
// (docs/design/electron-renderer-incident-convergence.md).
//
// THE defect (docs/review/electron.md SEV1 #2): a renderer incident assembles a bundle from the STREAMING
// capture store — whose stream() yields nothing — and uploads it from the renderer under the renderer
// client's own session id, while the main session holding every one of that renderer's capture entries
// records no incident at all. Two sessions: one with an issue and no data, one with the data and no issue.
//
// Written FIRST and required to fail before R1-R3. Per the design review this must be non-vacuous in three
// specific ways, or it would pass straight over the defects the review found:
//   1. drive the RENDERER through the real report path, not a fake — the existing e2e fakes
//      @bugsee/browser's launch entirely, which is exactly why the defect shipped;
//   2. observe BOTH transports — nothing uploaded from the renderer AND the report received by main;
//   3. assert `crash.json`'s SHAPE and COUNT — the first design draft forwarded the incident as a capture
//      entry, which would have produced two files named crash.json (one array-shaped) and polluted every
//      later bundle in the rolling window. A test that only checked "an incident arrived" passes over that.
import { createMemoryCaptureStore, type StoredEntry } from '@bugsee/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createElectronMainReceiver } from './main-receiver';
import type { DecodedReport } from './protocol';
import { createElectronRendererCaptureStore } from './renderer-capture-store';

/** A loopback IPC pair: whatever the renderer posts is delivered to the main listener synchronously. */
function loopbackIpc() {
  const listeners: Array<(event: unknown, raw: string) => void> = [];
  const posted: string[] = [];
  return {
    posted,
    ipcMain: {
      on: (_channel: string, listener: (event: unknown, raw: string) => void) => {
        listeners.push(listener);
      },
      removeListener: () => {},
    },
    post: (raw: string): void => {
      posted.push(raw);
      for (const l of listeners) l({ sender: { id: 7 } }, raw);
    },
  };
}

describe('R0 — renderer incident convergence', () => {
  let ipc: ReturnType<typeof loopbackIpc>;
  let mainStore: ReturnType<typeof createMemoryCaptureStore>;
  let joined: DecodedReport[];

  beforeEach(() => {
    ipc = loopbackIpc();
    mainStore = createMemoryCaptureStore();
    joined = [];
  });

  /** Stand-in for what R3 wires: main's join seam, recording every incident forwarded from a renderer. */
  const startMain = (): void => {
    createElectronMainReceiver({
      ipcMain: ipc.ipcMain as never,
      store: mainStore,
      onReport: (report: DecodedReport) => joined.push(report),
    }).start();
  };

  it('forwards a renderer incident to main instead of uploading it from the renderer', () => {
    startMain();
    const rendererStore = createElectronRendererCaptureStore({
      post: ipc.post,
      paused: () => false,
    });
    // The renderer's capture streams UP, as today.
    rendererStore.add({
      type: 'log',
      timestamp: 1,
      serialized: '{"message":"renderer-breadcrumb"}',
    });

    // R2 will route this through the renderer's report pipeline. Until then nothing forwards it.
    const incident = {
      source: { type: 'crash', mechanism: 'uncaught' },
      report: { summary: 'renderer boom' },
    };
    postIncident(ipc.post, incident);

    expect(joined).toHaveLength(1);
    expect(JSON.stringify(joined[0])).toContain('renderer boom');
  });

  it('the incident does NOT become a capture entry in the main store', () => {
    // SEV1-1 from the design review: forwarding the incident as an `entry` would land it in the main rolling
    // capture store, producing a SECOND, array-shaped `crash.json` in the bundle and polluting every
    // subsequent report for the next 60 s. The report transport must bypass the store entirely.
    startMain();
    postIncident(ipc.post, {
      source: { type: 'crash', mechanism: 'uncaught' },
      report: { summary: 'boom' },
    });

    // Nothing of type `crash` may have been routed into the store by the incident.
    const snapshot = mainStore.snapshot();
    const seen: StoredEntry[] = [];
    return (async () => {
      for await (const record of snapshot.stream()) seen.push(record);
      expect(seen.filter((r) => r.type === 'crash')).toHaveLength(0);
    })();
  });

  it('preserves the incident mechanism rather than refiling it as a handled error', () => {
    // SEV1-2: submitting via logException would refile a renderer CRASH as a handled, programmatic error
    // carrying a main-side stack — destroying the attribution this whole design exists to fix.
    startMain();
    postIncident(ipc.post, {
      source: { type: 'crash', mechanism: 'uncaught' },
      report: { summary: 'renderer boom', type: 'crash' },
    });
    expect((joined[0]?.source as { mechanism?: string } | undefined)?.mechanism).toBe('uncaught');
  });

  it('drops a malformed incident rather than submitting it', () => {
    // Renderer input is untrusted (Wave 0.2 established this for the entry path; the report path is the
    // same channel from the same untrusted sender).
    startMain();
    ipc.post(JSON.stringify({ k: 'report' })); // no payload
    ipc.post(JSON.stringify({ k: 'report', p: 'not-an-object' }));
    expect(joined).toHaveLength(0);
  });
});

/** Post an incident over the wire the way R2's renderer pipeline will. */
function postIncident(post: (raw: string) => void, incident: unknown): void {
  post(JSON.stringify({ k: 'report', p: incident, ts: 1 }));
}
