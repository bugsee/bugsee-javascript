// REAL-BROWSER masking e2e for the replay recorder (issue #120, and the blocked-iframe leak of issue #118).
//
// The unit/integration suites run on jsdom or on config. Only a real Chromium + the real rrweb bundle can show
// what actually lands in the events, so this drives the page the way a user's app does, collects EVERY event
// the recorder emits, and searches them for unique secrets. Each scenario also asserts a CONTROL that must be
// present (a `.bugsee-unmask` text), so a harness that sees nothing cannot pass vacuously, and one scenario
// runs with the masking switched off to prove the harness can fail.
//
// Two modes: `raw` calls rrweb's `record()` directly (the recorder's own guarantee) and `provider` goes through
// the SDK's replay capture provider, which adds the blocked-iframe guard. A recorder regression is therefore
// visible in `raw`, and `provider` shows what still reaches the bundle.
//
// HEADLESS ONLY: the browser is launched with `headless: true` explicitly (no window, no focus stealing). Do not
// change that: the harness never needs a visible browser.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const scenarioPath = fileURLToPath(new URL('../app/replay-masking-scenario.ts', import.meta.url));

// Test a CANDIDATE rrweb record bundle (e.g. a previous pin) without touching the install:
// `E2E_RRWEB_RECORD_BUNDLE=/path/to/record.js pnpm test:e2e replay-masking`.
const recordBundleOverride = process.env.E2E_RRWEB_RECORD_BUNDLE;

async function bundleScenario(): Promise<string> {
  const result = await build({
    ...(recordBundleOverride ? { alias: { '@bugsee/rrweb-record': recordBundleOverride } } : {}),
    entryPoints: [scenarioPath],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const out = result.outputFiles[0];
  if (out === undefined) throw new Error('esbuild produced no output');
  return out.text;
}

const frame = (n: number, extra = '') =>
  `<!doctype html><html><head><title>FRAME${n}_SECRET_DOC_TITLE</title></head><body>
<p id="ft">FRAME${n}_SECRET_TEXT</p>
<p class="bugsee-unmask" id="fc">CONTROL_FRAME${n}</p>
<input id="fi" type="text" placeholder="FRAME${n}_SECRET_PH" title="FRAME${n}_SECRET_TITLE">${extra}
</body></html>`;

const INDEX = `<!doctype html><html><head><title>replay masking e2e</title></head><body>
<p class="bugsee-unmask" id="topc">TOP_CONTROL</p>
<p id="tops">TOP_SECRET_TEXT</p>
<input id="topi" type="text" value="">
<div id="mount"></div>
<script src="/scenario.js"></script></body></html>`;

async function startPageServer(
  script: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/scenario.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(script);
      return;
    }
    const m = /^\/f(\d)\.html/.exec(url);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(m ? frame(Number(m[1])) : INDEX);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

type Mode = 'raw' | 'provider';

type Rm = {
  events: unknown[];
  start(mode: Mode, options: Record<string, unknown>): void;
  stop(): void;
  startBlackout(): void;
  stopBlackout(): void;
  snapshot(): void;
};

describe('replay masking — REAL Chromium + REAL rrweb bundle', () => {
  let browser: Browser;
  let server: { url: string; close: () => Promise<void> };
  let page: Page;

  beforeAll(async () => {
    const script = await bundleScenario();
    server = await startPageServer(script);
    // HEADLESS ONLY (see the header): never a visible window.
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  const settle = (ms = 250) => page.waitForTimeout(ms);

  async function open(): Promise<void> {
    page = await browser.newPage();
    await page.goto(server.url);
  }

  /** Mount iframes (`<iframe id=fN src=/fN.html attrs>`) and wait until each document has loaded. */
  async function mountFrames(
    ...frames: Array<{ id: string; n: number; attrs?: string }>
  ): Promise<void> {
    await page.evaluate(async (specs) => {
      const mount = document.getElementById('mount') as HTMLElement;
      const loaded: Array<Promise<void>> = [];
      for (const s of specs) {
        mount.insertAdjacentHTML(
          'beforeend',
          `<iframe id="${s.id}" src="/f${s.n}.html" ${s.attrs ?? ''}></iframe>`,
        );
        const f = document.getElementById(s.id) as HTMLIFrameElement;
        loaded.push(
          new Promise((resolve) => f.addEventListener('load', () => resolve(), { once: true })),
        );
      }
      await Promise.all(loaded);
    }, frames);
  }

  const start = (mode: Mode, options: Record<string, unknown> = {}) =>
    page.evaluate(
      ([m, o]) =>
        (window as unknown as { __rm: Rm }).__rm.start(m as Mode, o as Record<string, unknown>),
      [mode, options] as const,
    );

  const dump = async (): Promise<string> =>
    JSON.stringify(await page.evaluate(() => (window as unknown as { __rm: Rm }).__rm.events));

  const SECRETS = [
    'FRAME1_SECRET',
    'FRAME2_SECRET',
    'FRAME3_SECRET',
    'IFB_SECRET',
    'TOP_SECRET',
    'SHADOW_SECRET',
    'TYPED_SECRET',
  ];

  const leaks = (events: string): string[] => SECRETS.filter((s) => events.includes(s));

  /** A secret edit, typed value, added element and attribute inside the frame `id`. */
  const pokeFrame = (id: string, tag: string) =>
    page.evaluate(
      ([frameId, t]) => {
        const f = document.getElementById(frameId as string) as HTMLIFrameElement;
        const d = f.contentDocument as Document;
        const ft = d.getElementById('ft');
        if (ft) ft.textContent = `IFB_SECRET_EDIT_${t}`;
        const fi = d.getElementById('fi') as HTMLInputElement | null;
        if (fi) {
          fi.value = `TYPED_SECRET_${t}`;
          fi.dispatchEvent(new Event('input', { bubbles: true }));
          fi.setAttribute('placeholder', `IFB_SECRET_PH_${t}`);
        }
        const p = d.createElement('p');
        p.textContent = `IFB_SECRET_ADDED_${t}`;
        d.body.appendChild(p);
        d.dispatchEvent(new Event('scroll'));
      },
      [id, tag] as const,
    );

  const navigate = (id: string, n: number) =>
    page.evaluate(
      ([frameId, num]) =>
        new Promise<void>((resolve) => {
          const f = document.getElementById(frameId as string) as HTMLIFrameElement;
          f.addEventListener('load', () => resolve(), { once: true });
          f.src = `/f${num}.html`;
        }),
      [id, n] as const,
    );

  for (const mode of ['raw', 'provider'] as const) {
    describe(`mode: ${mode}`, () => {
      // The default options of the product: iframes blocked by the media selector.
      it('a default-blocked iframe contributes nothing: structure, text, placeholder, title, edits, navigation, re-add', async () => {
        await open();
        await mountFrames({ id: 'a', n: 1 });
        await start(mode);
        await settle();
        await pokeFrame('a', 'ONE');
        await navigate('a', 2);
        await settle();
        await pokeFrame('a', 'TWO');
        await page.evaluate(() => {
          const f = document.getElementById('a') as HTMLElement;
          const parent = f.parentElement as HTMLElement;
          f.remove();
          parent.appendChild(f);
        });
        await settle(400);
        await pokeFrame('a', 'THREE');
        await settle();
        const events = await dump();
        expect(events).toContain('TOP_CONTROL'); // harness sees the page
        expect(events).not.toContain('CONTROL_FRAME'); // a `.bugsee-unmask` text inside the blocked iframe
        expect(leaks(events)).toEqual([]);
        await page.close();
      });

      it('an explicit .bugsee-block iframe with maskAllText:false contributes nothing', async () => {
        await open();
        await mountFrames({ id: 'a', n: 1, attrs: 'class="bugsee-block"' });
        await start(mode, { maskAllText: false });
        await settle();
        await pokeFrame('a', 'ONE');
        await navigate('a', 2);
        await settle();
        await pokeFrame('a', 'TWO');
        await settle();
        const events = await dump();
        expect(events).toContain('TOP_SECRET_TEXT'); // maskAllText:false: the page text IS recorded (control)
        expect(events).not.toContain('CONTROL_FRAME');
        expect(leaks(events).filter((s) => s !== 'TOP_SECRET')).toEqual([]);
        await page.close();
      });

      it('maskAllText:false + blockAllMedia default: a blocked iframe still contributes nothing', async () => {
        await open();
        await mountFrames({ id: 'a', n: 1 });
        await start(mode, { maskAllText: false });
        await settle();
        await pokeFrame('a', 'ONE');
        await settle();
        const events = await dump();
        expect(events).toContain('TOP_SECRET_TEXT');
        expect(events).not.toContain('CONTROL_FRAME');
        expect(leaks(events).filter((s) => s !== 'TOP_SECRET')).toEqual([]);
        await page.close();
      });

      it('an explicitly unblocked iframe is recorded, and still masked by the rules', async () => {
        await open();
        await mountFrames({ id: 'a', n: 1, attrs: 'class="bugsee-show"' }, { id: 'b', n: 3 });
        await start(mode);
        await settle(400);
        await pokeFrame('a', 'ONE');
        await settle();
        const events = await dump();
        expect(events).toContain('CONTROL_FRAME1'); // the unblocked iframe's `.bugsee-unmask` text IS recorded
        expect(events).not.toContain('CONTROL_FRAME3'); // the default-blocked neighbour is not
        expect(leaks(events)).toEqual([]); // everything else in the unblocked one is masked
        await page.close();
      });

      it('shadow DOM: host removed and re-added, nested roots, host moved, shadow attached while detached', async () => {
        await open();
        await page.evaluate(() => {
          const mount = document.getElementById('mount') as HTMLElement;
          const host = document.createElement('div');
          host.id = 'h1';
          host.attachShadow({ mode: 'open' }).innerHTML =
            '<p>SHADOW_SECRET_ONE</p><p class="bugsee-unmask">CONTROL_SHADOW</p><input type="text">';
          mount.appendChild(host);
        });
        await start(mode);
        await settle();
        await page.evaluate(() => {
          const mount = document.getElementById('mount') as HTMLElement;
          const host = document.getElementById('h1') as HTMLElement;
          const root = host.shadowRoot as ShadowRoot;
          // removed and re-added
          host.remove();
          mount.appendChild(host);
          // changes after the re-add
          const p = document.createElement('p');
          p.textContent = 'SHADOW_SECRET_TWO';
          root.appendChild(p);
          const input = root.querySelector('input') as HTMLInputElement;
          input.value = 'TYPED_SECRET_SHADOW';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          // nested roots
          const inner = document.createElement('div');
          root.appendChild(inner);
          inner.attachShadow({ mode: 'open' }).innerHTML = '<p>SHADOW_SECRET_NESTED</p>';
          // moved between roots
          const other = document.createElement('div');
          mount.appendChild(other);
          const otherRoot = other.attachShadow({ mode: 'open' });
          otherRoot.appendChild(inner);
          (otherRoot.firstChild as HTMLElement).shadowRoot?.appendChild(
            document.createTextNode('SHADOW_SECRET_MOVED'),
          );
          // attached while detached, then connected
          const late = document.createElement('div');
          late.attachShadow({ mode: 'open' }).innerHTML = '<p>SHADOW_SECRET_LATE</p>';
          mount.appendChild(late);
        });
        await settle(400);
        const events = await dump();
        expect(events).toContain('CONTROL_SHADOW'); // the `.bugsee-unmask` text inside the shadow root is recorded
        expect(leaks(events)).toEqual([]);
        await page.close();
      });

      it('stop/start cycles and a blackout: nothing typed or changed in between is recorded in the clear', async () => {
        await open();
        await start(mode);
        await settle();
        await page.evaluate(() => (window as unknown as { __rm: Rm }).__rm.startBlackout());
        await page.evaluate(() => {
          const p = document.getElementById('tops') as HTMLElement;
          p.textContent = 'TOP_SECRET_DURING_BLACKOUT';
          const i = document.getElementById('topi') as HTMLInputElement;
          i.value = 'TYPED_SECRET_BLACKOUT';
          i.dispatchEvent(new Event('input', { bubbles: true }));
          for (let n = 0; n < 50; n++) {
            const x = document.createElement('p');
            x.textContent = `TOP_SECRET_BURST_${n}`;
            document.body.appendChild(x);
          }
        });
        await page.evaluate(() => (window as unknown as { __rm: Rm }).__rm.stopBlackout());
        await settle(400);
        await page.evaluate(() => (window as unknown as { __rm: Rm }).__rm.stop());
        await page.evaluate(() => {
          (document.getElementById('tops') as HTMLElement).textContent = 'TOP_SECRET_WHILE_STOPPED';
        });
        await start(mode);
        await settle();
        await page.evaluate(() => {
          (document.getElementById('tops') as HTMLElement).textContent = 'TOP_SECRET_AFTER_RESTART';
        });
        await settle();
        const events = await dump();
        expect(events).toContain('TOP_CONTROL');
        expect(leaks(events)).toEqual([]);
        await page.close();
      });
    });
  }

  it('control: with maskAllText and maskAllInputs switched off the same page DOES leak (the harness can fail)', async () => {
    await open();
    await mountFrames({ id: 'a', n: 3, attrs: 'class="bugsee-show"' });
    await start('raw', { maskAllText: false, maskAllInputs: false, blockAllMedia: false });
    await settle(400);
    await pokeFrame('a', 'ONE');
    await page.evaluate(() => {
      const i = document.getElementById('topi') as HTMLInputElement;
      i.value = 'TYPED_SECRET_TOP';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const found = leaks(await dump());
    expect(found).toContain('TOP_SECRET');
    expect(found).toContain('TYPED_SECRET');
    expect(found).toContain('FRAME3_SECRET');
    await page.close();
  });
});
