// Renderer half of the real-Electron smoke: the real `launchRenderer` inside a sandboxed window.
import { launchRenderer } from '../../../electron/src/renderer';

const w = window as unknown as Record<string, unknown>;
(async () => {
  try {
    let sid: string | undefined;
    await launchRenderer('tok', {
      onSessionId: (s: string) => {
        sid = s;
      },
    } as never);
    console.log('RENDERER-LOG-MARKER hello from renderer');
    // Let the streamed capture reach main before the result is published.
    await new Promise((r) => setTimeout(r, 1500));
    w.__result = { ok: true, sid, bridge: typeof w.__bugseeElectron, probe: w.__probe };
  } catch (e) {
    w.__result = { ok: false, err: String((e as Error)?.stack ?? e) };
  }
})();
