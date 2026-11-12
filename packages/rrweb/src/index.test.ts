import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { record } from './index';

const require = createRequire(import.meta.url);

describe('@bugsee/rrweb wrapper', () => {
  it('re-exports the rrweb record function (the single record-path import point)', () => {
    // The wrapper decouples @bugsee/replay from rrweb's packaging — swapping npm → the Bugsee fork touches
    // only this module. Assert the value it forwards is rrweb's callable record().
    expect(typeof record).toBe('function');
  });

  it('is wired to the 2.2.2 record-only bundle', () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(require.resolve('@bugsee/rrweb-record')), 'package.json'), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe('2.2.2');
  });

  // Provenance pin: the vendored bundle is the ONLY copy until bugsee/rrweb has bugsee-dist-2.2.2, so a
  // silent swap (e.g. a plain upstream build) must fail loudly. Update together with the README when rebuilt.
  it('pins the vendored record.js by sha256', () => {
    const file = join(dirname(require.resolve('@bugsee/rrweb-record')), 'record.js');
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    expect(sha).toBe('14b28561c371d25da7557b7f8446aabdc4b335cfbfd308457632d3b7d252ed3c');
  });

  it('records media interaction for a <video> inside an iframe (cross-realm nodeName check)', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument as Document;
    const video = doc.createElement('video');
    doc.body.appendChild(video);
    const events: Array<{ type: number; data: { source?: number; type?: number } }> = [];
    const stop = record({ emit: (e) => events.push(e as never), recordCrossOriginIframes: false });
    await new Promise((r) => setTimeout(r, 50));
    video.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('play'));
    await new Promise((r) => setTimeout(r, 50));
    stop?.();
    iframe.remove();
    // IncrementalSource.MediaInteraction === 7. Upstream's `instanceof HTMLMediaElement` is false across
    // realms and would drop this event.
    expect(events.some((e) => e.type === 3 && e.data.source === 7)).toBe(true);
  });
});
