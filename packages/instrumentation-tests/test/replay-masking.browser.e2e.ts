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
import { createServer, type Server, type ServerResponse } from 'node:http';
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

const pendingCss: ServerResponse[] = [];
const cssWaiters: Array<() => void> = [];

/** Answer the stylesheet request that is being held, waiting for it to arrive first (no fixed delay). */
async function releaseCss(): Promise<void> {
  if (pendingCss.length === 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the stylesheet was never requested')),
        10_000,
      );
      cssWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  for (const res of pendingCss.splice(0)) {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('p::after{content:"LINK_SECRET_CSS"}');
  }
}

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
    if (url.startsWith('/slow.css')) {
      // held until the test releases it, so it finishes loading exactly when the test wants
      pendingCss.push(res);
      for (const waiter of cssWaiters.splice(0)) waiter();
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
  errors: string[];
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
    'LINK_SECRET',
    'STYLE_SECRET',
    'LATE_SECRET',
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

      it('a contextual unblockSelector keeps the iframe recorded, with no guard violation (#123)', async () => {
        await open();
        await mountFrames({ id: 'a', n: 1 }, { id: 'b', n: 3 });
        await start(mode, { unblockSelector: '#mount > iframe#a' }); // matches only the first frame
        await settle(400);
        await pokeFrame('a', 'CTX');
        await settle();
        const events = await dump();
        expect(events).toContain('CONTROL_FRAME1'); // the iframe's document IS recorded
        expect(events).not.toContain('CONTROL_FRAME3'); // the non-matching neighbour stays blocked
        expect(leaks(events)).toEqual([]); // and still masked by the rules
        const errors = await page.evaluate(() => (window as unknown as { __rm: Rm }).__rm.errors);
        expect(errors).toEqual([]);
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

  // ---------------------------------------------------------------------------------------------------------
  // Iframes that are recorded and then REFUSED or RELEASED: an ancestor or the iframe itself becomes blocked while
  // recording. These are the scenarios a review of the first version of the fix found leaking (shadow roots and
  // adopted style sheets of a document whose iframe was blocked later, in the recorder AND past the SDK guard).
  // ---------------------------------------------------------------------------------------------------------
  const mountRecorded = async (wrapped: boolean, attrs: string, src = '/f1.html') => {
    await page.evaluate(
      async ([w, a, source]) => {
        const mount = document.getElementById('mount') as HTMLElement;
        mount.insertAdjacentHTML(
          'beforeend',
          w
            ? `<div id="wrap"><iframe id="a" ${a} src="${source}"></iframe></div>`
            : `<iframe id="a" ${a} src="${source}"></iframe>`,
        );
        const f = document.getElementById('a') as HTMLIFrameElement;
        await new Promise((resolve) => f.addEventListener('load', resolve, { once: true }));
      },
      [wrapped, attrs, src] as const,
    );
  };

  const shadowIn = (value: string) =>
    page.evaluate((v) => {
      const d = (document.getElementById('a') as HTMLIFrameElement).contentDocument as Document;
      const host = d.getElementById('ft') as HTMLElement;
      const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
      const p = d.createElement('p');
      p.textContent = v;
      root.appendChild(p);
    }, value);

  const adopt = (value: string) =>
    page.evaluate((v) => {
      const f = document.getElementById('a') as HTMLIFrameElement;
      const w = f.contentWindow as unknown as { CSSStyleSheet: typeof CSSStyleSheet };
      const sheet = new w.CSSStyleSheet();
      sheet.replaceSync(`#ft::after{content:"${v}"}`);
      (f.contentDocument as Document).adoptedStyleSheets = [sheet];
    }, value);

  const markers = async (): Promise<number> =>
    (
      JSON.parse(await dump()) as Array<{
        type: number;
        data: { source?: number; attributes?: Array<{ attributes: object }> };
      }>
    ).filter(
      (e) =>
        e.type === 3 &&
        e.data.source === 0 &&
        e.data.attributes?.length === 1 &&
        'rr_width' in (e.data.attributes[0]?.attributes ?? {}),
    ).length;

  for (const mode of ['raw', 'provider'] as const) {
    describe(`mode: ${mode} — refused or released after recording`, () => {
      it('an ancestor becomes blocked, the iframe navigates, a shadow root is attached in it', async () => {
        await open();
        await mountRecorded(true, 'class="bugsee-show"');
        await start(mode, { maskAllText: false });
        await settle(400);
        const before = await dump();
        expect(before).toContain('FRAME1_SECRET_TEXT'); // recorded while allowed (control)
        await page.evaluate(() =>
          (document.getElementById('wrap') as HTMLElement).classList.add('bugsee-block'),
        );
        await settle();
        await navigate('a', 2);
        await settle(300);
        await shadowIn('SHADOW_SECRET_LATE_A');
        await settle(300);
        await shadowIn('SHADOW_SECRET_LATE_A2');
        await settle(300);
        const events = await dump();
        expect(events).not.toContain('SHADOW_SECRET_LATE');
        expect(events).not.toContain('FRAME2_SECRET');
        expect(await markers()).toBe(1);
        await page.close();
      });

      it('the same with blockAllMedia off and no class on the iframe at all', async () => {
        await open();
        await mountRecorded(true, '');
        await start(mode, { maskAllText: false, blockAllMedia: false });
        await settle(400);
        expect(await dump()).toContain('FRAME1_SECRET_TEXT'); // recorded while allowed (control)
        await page.evaluate(() =>
          (document.getElementById('wrap') as HTMLElement).classList.add('bugsee-block'),
        );
        await settle();
        await navigate('a', 2);
        await settle(300);
        await shadowIn('SHADOW_SECRET_LATE_B');
        await settle(300);
        await shadowIn('SHADOW_SECRET_LATE_B2');
        await settle(300);
        const events = await dump();
        expect(events).not.toContain('SHADOW_SECRET_LATE');
        expect(events).not.toContain('FRAME2_SECRET');
        expect(await markers()).toBe(1);
        await page.close();
      });

      it('an ancestor becomes blocked, then the iframe document adopts a style sheet', async () => {
        await open();
        await mountRecorded(true, 'class="bugsee-show"');
        await start(mode, { maskAllText: false });
        await settle(400);
        await adopt('STYLE_SECRET_EARLY'); // allowed so far: recorded (control)
        await settle(300);
        expect(await dump()).toContain('STYLE_SECRET_EARLY');
        await page.evaluate(() =>
          (document.getElementById('wrap') as HTMLElement).classList.add('bugsee-block'),
        );
        await settle();
        await adopt('STYLE_SECRET_LATE');
        await settle(300);
        expect(await dump()).not.toContain('STYLE_SECRET_LATE');
        await page.close();
      });

      it("the iframe's own .bugsee-show is removed, then it adopts a style sheet and its text/inputs change", async () => {
        await open();
        await mountRecorded(false, 'class="bugsee-show"');
        await start(mode, { maskAllText: false, maskAllInputs: false });
        await settle(400);
        await page.evaluate(() =>
          (document.getElementById('a') as HTMLElement).classList.remove('bugsee-show'),
        );
        await settle();
        await adopt('STYLE_SECRET_LATE_C');
        await page.evaluate(() => {
          const d = (document.getElementById('a') as HTMLIFrameElement).contentDocument as Document;
          (d.getElementById('ft') as HTMLElement).textContent = 'LATE_SECRET_TEXT';
          const i = d.getElementById('fi') as HTMLInputElement;
          i.value = 'TYPED_SECRET_LATE';
          i.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await settle(400);
        const events = await dump();
        expect(events).not.toContain('STYLE_SECRET_LATE_C');
        expect(events).not.toContain('LATE_SECRET_TEXT');
        expect(events).not.toContain('TYPED_SECRET_LATE');
        expect(await markers()).toBe(1);
        await page.close();
      });

      it('control: a stylesheet link that finishes loading while the iframe is allowed IS recorded', async () => {
        await open();
        await mountRecorded(false, 'class="bugsee-show"');
        await start(mode, { maskAllText: false });
        await settle(400);
        await page.evaluate(() => {
          const d = (document.getElementById('a') as HTMLIFrameElement).contentDocument as Document;
          const link = d.createElement('link');
          link.rel = 'stylesheet';
          link.href = '/slow.css';
          d.head.appendChild(link);
        });
        await releaseCss();
        await settle(500);
        expect(await dump()).toContain('LINK_SECRET_CSS');
        await page.close();
      });

      it('iframe becomes blocked after recording: text, input, adopted sheet, shadow DOM and a stylesheet link', async () => {
        await open();
        await mountRecorded(false, 'class="bugsee-show"');
        await start(mode, { maskAllText: false, maskAllInputs: false });
        await settle(400);
        // a stylesheet link that is still loading when the iframe becomes blocked
        await page.evaluate(() => {
          const d = (document.getElementById('a') as HTMLIFrameElement).contentDocument as Document;
          const link = d.createElement('link');
          link.rel = 'stylesheet';
          link.href = '/slow.css';
          d.head.appendChild(link);
        });
        await settle(200);
        // while it is allowed everything is recorded (the control that makes the rest meaningful)
        await page.evaluate(() => {
          const d = (document.getElementById('a') as HTMLIFrameElement).contentDocument as Document;
          (d.getElementById('ft') as HTMLElement).textContent = 'EARLY_TEXT_OK';
        });
        await adopt('STYLE_EARLY_OK');
        await settle(300);
        const early = await dump();
        expect(early).toContain('EARLY_TEXT_OK');
        expect(early).toContain('STYLE_EARLY_OK');

        await page.evaluate(() =>
          (document.getElementById('a') as HTMLElement).classList.remove('bugsee-show'),
        );
        await page.evaluate(() => {
          const d = (document.getElementById('a') as HTMLIFrameElement).contentDocument as Document;
          (d.getElementById('ft') as HTMLElement).textContent = 'LATE_SECRET_TEXT';
          const i = d.getElementById('fi') as HTMLInputElement;
          i.value = 'TYPED_SECRET_LATE';
          i.dispatchEvent(new Event('input', { bubbles: true }));
          d.dispatchEvent(new Event('scroll'));
        });
        await adopt('STYLE_SECRET_LATE_E');
        await shadowIn('SHADOW_SECRET_LATE_E');
        await releaseCss(); // the link finishes loading now, after the iframe was blocked
        await settle(500);
        const events = await dump();
        for (const secret of [
          'LATE_SECRET_TEXT',
          'TYPED_SECRET_LATE',
          'STYLE_SECRET_LATE_E',
          'SHADOW_SECRET_LATE_E',
          'LINK_SECRET_CSS',
        ]) {
          expect(events).not.toContain(secret);
        }
        expect(await markers()).toBe(1);
        await page.close();
      });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Secrets in every place a page keeps them: prefilled and typed input values (text, password, card, e-mail),
  // textarea, `alt`, `title`, `placeholder`, `aria-label`, `data-*`, element text; both present BEFORE recording
  // starts (the full snapshot) and ADDED / EDITED after (the mutation path).
  // ---------------------------------------------------------------------------------------------------------
  const ATTR_CATEGORIES = [
    'TEXT',
    'PASSWORD',
    'CC',
    'EMAIL',
    'TEXTAREA',
    'ALT',
    'IMGTITLE',
    'TITLE',
    'DATA',
    'ARIA',
    'LINK',
    'PH',
    'DATAUSER',
    'DIVTITLE',
    'DIV',
    'TYPED',
  ];
  const attrSecrets = (phase: string) => ATTR_CATEGORIES.map((c) => `ATTRSMOKE_${c}_${phase}`);
  const attrLeaks = (events: string) =>
    attrSecrets('PRE')
      .concat(attrSecrets('ADDED'))
      .filter((s) => events.includes(s));

  const insertAttrFixture = (phase: string) =>
    page.evaluate((p) => {
      const mount = document.getElementById('mount') as HTMLElement;
      mount.insertAdjacentHTML(
        'beforeend',
        `<section id="smoke_${p}">
<input type="text" value="ATTRSMOKE_TEXT_${p}">
<input type="password" value="ATTRSMOKE_PASSWORD_${p}">
<input type="text" autocomplete="cc-number" value="ATTRSMOKE_CC_${p}">
<input type="email" value="ATTRSMOKE_EMAIL_${p}">
<textarea>ATTRSMOKE_TEXTAREA_${p}</textarea>
<img alt="ATTRSMOKE_ALT_${p}" title="ATTRSMOKE_IMGTITLE_${p}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<a href="#" title="ATTRSMOKE_TITLE_${p}" data-token="ATTRSMOKE_DATA_${p}" aria-label="ATTRSMOKE_ARIA_${p}">ATTRSMOKE_LINK_${p}</a>
<input type="text" placeholder="ATTRSMOKE_PH_${p}">
<div data-user="ATTRSMOKE_DATAUSER_${p}" title="ATTRSMOKE_DIVTITLE_${p}">ATTRSMOKE_DIV_${p}</div>
<input class="typed" type="text">
</section>`,
      );
    }, phase);

  const typeAttrSecret = () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLInputElement>('input.typed')) {
        el.value = 'ATTRSMOKE_TYPED_PRE';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

  const runAttrSmoke = async (mode: Mode, options: Record<string, unknown>) => {
    await open();
    await insertAttrFixture('PRE');
    await start(mode, options);
    await settle();
    await insertAttrFixture('ADDED');
    await typeAttrSecret();
    await settle(400);
    return dump();
  };

  for (const mode of ['raw', 'provider'] as const) {
    it(`attribute/value smoke (${mode}): no secret in values, text, alt, title, placeholder, aria, data-* at defaults`, async () => {
      const events = await runAttrSmoke(mode, {});
      expect(events).toContain('TOP_CONTROL'); // the harness sees the page (control)
      expect(attrLeaks(events)).toEqual([]);
      await page.close();
    });
  }

  it('control: the attribute smoke fixture DOES leak with masking off (every category is detectable)', async () => {
    const events = await runAttrSmoke('raw', {
      maskAllText: false,
      maskAllInputs: false,
      blockAllMedia: false,
    });
    const found = attrLeaks(events);
    // the always-masked sensitive inputs (password, card) must NOT appear even here: the hard floor
    expect(found).not.toContain('ATTRSMOKE_PASSWORD_PRE');
    expect(found).not.toContain('ATTRSMOKE_CC_PRE');
    // the rest were recorded in the clear, so the harness can see each category
    for (const c of ['TEXT', 'EMAIL', 'TEXTAREA', 'ALT', 'TITLE', 'PH', 'DIV', 'LINK', 'TYPED']) {
      expect(found, `${c} should be visible when masking is off`).toContain(`ATTRSMOKE_${c}_PRE`);
    }
    await page.close();
  });

  // ---------------------------------------------------------------------------------------------------------
  // document.open(): rewrites a document in place (replaces a frame's content without a navigation).
  // ---------------------------------------------------------------------------------------------------------
  const rewriteFrame = (id: string, html: string) =>
    page.evaluate(
      ([frameId, markup]) => {
        const d = (document.getElementById(frameId as string) as HTMLIFrameElement)
          .contentDocument as Document;
        d.open();
        d.write(markup as string);
        d.close();
      },
      [id, html] as const,
    );

  const REWRITTEN =
    '<!doctype html><html><body><p id="ft">FRAME4_SECRET_REWRITTEN</p><input id="fi" type="text" value="TYPED_SECRET_REWRITTEN"><p class="bugsee-unmask">CONTROL_REWRITTEN</p></body></html>';

  for (const mode of ['raw', 'provider'] as const) {
    it(`document.open (${mode}): a blocked iframe rewritten in place contributes nothing`, async () => {
      await open();
      await mountFrames({ id: 'a', n: 1 });
      await start(mode);
      await settle();
      await rewriteFrame('a', REWRITTEN);
      await settle(400);
      await pokeFrame('a', 'AFTEROPEN');
      await settle();
      const events = await dump();
      expect(events).toContain('TOP_CONTROL');
      expect(events).not.toContain('CONTROL_REWRITTEN');
      expect(events).not.toContain('FRAME4_SECRET');
      expect(events).not.toContain('TYPED_SECRET_REWRITTEN');
      expect(leaks(events)).toEqual([]);
      await page.close();
    });

    it(`document.open (${mode}): an unblocked iframe rewritten in place stays masked`, async () => {
      await open();
      await mountFrames({ id: 'a', n: 1, attrs: 'class="bugsee-show"' });
      await start(mode);
      await settle(400);
      await rewriteFrame('a', REWRITTEN);
      await settle(400);
      await pokeFrame('a', 'AFTEROPEN');
      await settle();
      const events = await dump();
      expect(events).toContain('CONTROL_FRAME1'); // the unblocked frame was recorded before the rewrite (control)
      expect(events).not.toContain('FRAME4_SECRET');
      expect(events).not.toContain('TYPED_SECRET_REWRITTEN');
      expect(leaks(events)).toEqual([]);
      await page.close();
    });
  }

  it('control: document.open content DOES leak with masking off, and a blocked iframe still does not', async () => {
    await open();
    await mountFrames({ id: 'a', n: 1, attrs: 'class="bugsee-show"' }, { id: 'b', n: 3 });
    await start('raw', { maskAllText: false, maskAllInputs: false });
    await settle(400);
    await rewriteFrame('a', REWRITTEN.replace('FRAME4_SECRET', 'FRAME4_SECRET_UNBLOCKED'));
    await rewriteFrame('b', REWRITTEN.replace('FRAME4_SECRET', 'FRAME4_SECRET_BLOCKED'));
    await settle(500);
    const events = await dump();
    expect(events).toContain('FRAME4_SECRET_UNBLOCKED_REWRITTEN'); // visible in the unblocked frame: the harness can fail
    expect(events).not.toContain('FRAME4_SECRET_BLOCKED'); // ...but nothing from the blocked one
    await page.close();
  });

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
