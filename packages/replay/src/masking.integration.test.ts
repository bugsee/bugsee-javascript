// @vitest-environment jsdom
import { record } from '@bugsee/rrweb';
import { afterEach, describe, expect, it } from 'vitest';
import { type ReplayMaskingOptions, resolveReplayMaskingOptions } from './masking';

// Wave 1.3/1.4 — the masking guarantees asserted against REAL rrweb over a REAL DOM.
//
// Every masking test in this package used to assert the RESOLVER'S RETURN VALUE ("maskInputOptions equals
// {password:true}") and the recorder tests drove a FAKE `record`. That is why three fail-open defects
// survived a suite at 100% coverage: rrweb never consults `maskInputOptions` on the unmask path, so a
// property of the config object says nothing about what is serialized (docs/review/replay.md SEV1 #1/#2/#3,
// and its "Masking fail-closed audit" table, whose right-hand column is ✗ on every row).
//
// These tests read the bytes rrweb actually emits. A guarantee that cannot be observed here is not a
// guarantee.

const SNAPSHOT_EVENT = 2; // rrweb EventType.FullSnapshot

interface Driven {
  json: string;
  events: Array<{ type: number }>;
}

/** Record `html` through the REAL rrweb with the REAL resolved masking, and return what it emitted. */
async function drive(
  html: string,
  options: ReplayMaskingOptions = {},
  act?: () => void,
): Promise<Driven> {
  document.body.innerHTML = html;
  const events: Array<{ type: number }> = [];
  const stop = record({
    ...resolveReplayMaskingOptions(options),
    emit: (event: unknown) => events.push(event as { type: number }),
  } as never);
  act?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop?.();
  return { json: JSON.stringify(events), events };
}

/** Type into an input the way a user does, so the LIVE input observer path runs (not just the snapshot). */
const typeInto = (selector: string, value: string) => () => {
  const el = document.querySelector(selector) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the password / sensitive-input floor is genuinely non-overridable', () => {
  it('masks a password input at defaults (control)', async () => {
    const { json } = await drive('<input type="password" value="PWSECRET">');
    expect(json).not.toContain('PWSECRET');
  });

  it('masks a password input marked `.bugsee-unmask`', async () => {
    // The documented invariant: "Password inputs are ALWAYS masked — never unmaskable". rrweb checks the
    // unmask selector FIRST and short-circuits the whole masking call, so reusing the text unmask selector
    // for inputs silently voided the floor (SEV1 #1, reproduced verbatim before this fix).
    const { json } = await drive('<input type="password" class="bugsee-unmask" value="PWSECRET">');
    expect(json).not.toContain('PWSECRET');
  });

  it('masks a password input marked `[data-bugsee-unmask]`', async () => {
    const { json } = await drive('<input type="password" data-bugsee-unmask value="PWSECRET">');
    expect(json).not.toContain('PWSECRET');
  });

  it('masks a password input when the caller un-masks EVERYTHING with `*`', async () => {
    const { json } = await drive('<input type="password" value="PWSECRET">', {
      unmaskTextSelector: '*',
    });
    expect(json).not.toContain('PWSECRET');
  });

  it('masks a `.bugsee-unmask` password through a show/hide reveal toggle', async () => {
    // The real widget starts as `type=password` and flips to `text` to reveal. The guard covers the
    // snapshot, and rrweb emits only the attribute mutation on the flip — never the value — so the reveal
    // cannot leak it either.
    const { json } = await drive(
      '<input type="password" class="bugsee-unmask" id="pw" value="PWSECRET">',
      {},
      () => {
        document.querySelector('#pw')?.setAttribute('type', 'text');
      },
    );
    expect(json).not.toContain('PWSECRET');
  });

  it('masks a credit-card input marked `.bugsee-unmask`', async () => {
    const { json } = await drive(
      '<input type="text" autocomplete="cc-number" class="bugsee-unmask" value="4111111111111111">',
    );
    expect(json).not.toContain('4111111111111111');
  });

  it('masks a case-variant `type="PASSWORD"` marked `.bugsee-unmask`', async () => {
    const { json } = await drive('<input type="PASSWORD" class="bugsee-unmask" value="PWSECRET">');
    expect(json).not.toContain('PWSECRET');
  });

  it('masks a case-variant `autocomplete="CC-NUMBER"` marked `.bugsee-unmask`', async () => {
    // `type` is matched ASCII-case-insensitively by the HTML spec, so the previous test passes with or
    // without the selector's ` i` flag. `autocomplete` is NOT on that list (measured: `[autocomplete*="cc-"]`
    // does not match `CC-NUMBER`), so this is the case that actually pins the flag — and without it a
    // capitalised card field marked `.bugsee-unmask` ships a full PAN.
    const { json } = await drive(
      '<input type="text" autocomplete="CC-NUMBER" class="bugsee-unmask" value="4111111111111111">',
    );
    expect(json).not.toContain('4111111111111111');
  });

  // KNOWN RESIDUAL — the show-password toggle is only PARTLY closed, and deliberately has no test here.
  // rrweb stamps `data-rr-is-password` when it OBSERVES the type flip, and the masking config now honours
  // that stamp (asserted deterministically in masking.test.ts). But a full-snapshot checkout that lands
  // before the mutation observer fires sees the field as plain `type=text` + `.bugsee-unmask` and serialises
  // the value. An end-to-end test of this is inherently racy — a first draft of one failed ~40% of runs —
  // and a flaky test is worse than an honest note. Closing it fully needs the fork to stamp synchronously.

  it('masks a multi-token `autocomplete="webauthn one-time-code"` marked `.bugsee-unmask`', async () => {
    // `autocomplete` is a TOKEN LIST. The matcher used `=` (exact value), so any OTP field that also
    // declares `webauthn` — the documented pairing for WebAuthn-assisted autofill — was not on the floor
    // and `.bugsee-unmask` lifted it. `~=` is the token-list operator and matches a strict superset.
    const { json } = await drive(
      '<input type="text" autocomplete="webauthn one-time-code" class="bugsee-unmask" value="123456">',
    );
    expect(json).not.toContain('123456');
  });

  it('STILL un-masks a benign input marked `.bugsee-unmask` — the escape hatch survives', async () => {
    // The floor must be surgical: closing it by refusing to un-mask anything would be a different product.
    const { json } = await drive('<input type="text" class="bugsee-unmask" value="SEARCHTERM">');
    expect(json).toContain('SEARCHTERM');
  });
});

describe('the sensitive floor holds on the LIVE input path too, with maskAllInputs off', () => {
  // Review round 1 (replay reviewer, SEV1 #1): this block previously covered ONLY `tel` and `password` —
  // the two categories that happened to work — while the module header claimed a floor "no option and no
  // DOM marking can lift". `maskInputOptions` is keyed by input TYPE, so it cannot name a field declared
  // sensitive by `autocomplete`, and the fork's live observer gates on that map alone. Those values were
  // emitted RAW. The fix is to stop recording their input events at all (the ignore set).
  const sensitive: Array<[string, string, string]> = [
    ['type=password', '<input type="password" id="f">', 'PWSECRET'],
    ['type=tel', '<input type="tel" id="f">', '5558675309'],
    [
      'autocomplete=cc-number',
      '<input type="text" autocomplete="cc-number" id="f">',
      '4111111111111111',
    ],
    [
      'autocomplete=one-time-code',
      '<input type="text" autocomplete="one-time-code" id="f">',
      '123456',
    ],
    [
      'autocomplete=current-password',
      '<input type="text" autocomplete="current-password" id="f">',
      'PWSECRET',
    ],
    [
      'autocomplete=new-password',
      '<input type="text" autocomplete="new-password" id="f">',
      'PWSECRET',
    ],
    [
      'multi-token autocomplete',
      '<input type="text" autocomplete="section-b shipping cc-number" id="f">',
      '4111111111111111',
    ],
    [
      // The multi-token case above uses `cc-`, matched with `*=`, so it passed whatever the OTHER matchers
      // did. `one-time-code` was matched with `=` — EXACT value — and `autocomplete` is a TOKEN LIST:
      // `webauthn one-time-code` is spec-valid and is what you write for WebAuthn-assisted OTP autofill.
      // It fell outside the floor entirely, so `.bugsee-unmask` could lift it.
      'multi-token autocomplete with one-time-code',
      '<input type="text" autocomplete="webauthn one-time-code" id="f">',
      '123456',
    ],
  ];

  for (const [label, html, secret] of sensitive) {
    it(`masks a ${label} value typed by the user`, async () => {
      const { json } = await drive(html, { maskAllInputs: false }, () => typeInto('#f', secret)());
      expect(json).not.toContain(secret);
    });
  }

  it('masks a `type=tel` value already present in the snapshot', async () => {
    const { json } = await drive('<input type="tel" value="5558675309">', {
      maskAllInputs: false,
    });
    expect(json).not.toContain('5558675309');
  });

  it('still records a BENIGN input’s typing when maskAllInputs is off', async () => {
    // The floor must stay surgical: ignoring every input would be a different product.
    const { json } = await drive('<input type="text" id="f">', { maskAllInputs: false }, () =>
      typeInto('#f', 'SEARCHTERM')(),
    );
    expect(json).toContain('SEARCHTERM');
  });
});

describe('attribute masking is fail-CLOSED — an allowlist, not an 11-entry denylist', () => {
  it('masks `data-*` attributes carrying user identity at DEFAULT settings', async () => {
    // The highest-reach hole in the package: no opt-out, no misconfiguration, no unusual markup needed.
    const { json } = await drive(
      '<div data-user-email="victim@example.com" data-customer-name="Jane Doe">x</div>',
    );
    expect(json).not.toContain('victim@example.com');
    expect(json).not.toContain('Jane Doe');
  });

  it('masks `<meta content>`', async () => {
    const { json } = await drive('<meta name="x" content="ACCOUNTSECRETMETA">');
    expect(json).not.toContain('ACCOUNTSECRETMETA');
  });

  it('masks an arbitrary custom attribute nobody could have enumerated', async () => {
    const { json } = await drive('<div x-account-ref="CUSTOMSECRET">x</div>');
    expect(json).not.toContain('CUSTOMSECRET');
  });

  it('still masks the attributes the old denylist covered', async () => {
    const { json } = await drive(
      '<input title="TITLESECRET" alt="ALTSECRET" placeholder="PHSECRET" aria-label="ARIASECRET">',
    );
    for (const secret of ['TITLESECRET', 'ALTSECRET', 'PHSECRET', 'ARIASECRET']) {
      expect(json, secret).not.toContain(secret);
    }
  });

  it('documents the residual: URL attributes never reach the masker at all', async () => {
    // Measured, not assumed. Instrumenting `maskAttributeFn` over a page carrying `href`/`src` shows only
    // `data-x` arriving — rrweb resolves URL attributes on its own path. So a secret inside a URL is NOT
    // maskable from this seam, and claiming otherwise would be worse than the leak. Closing it needs a
    // change in the rrweb fork; this test fails loudly if that ever lands, prompting the real fix here.
    const seen: string[] = [];
    document.body.innerHTML = '<a href="/reset?token=URLTOKENSECRET" data-x="Y">go</a>';
    const stop = record({
      ...resolveReplayMaskingOptions(),
      maskAttributeFn: (key: string) => {
        seen.push(key);
        return '';
      },
      emit: () => {},
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop?.();
    expect(seen).toContain('data-x');
    expect(seen).not.toContain('href');
  });

  it('leaves rendering-critical attributes untouched, so replay still renders', async () => {
    const { json } = await drive(
      '<div class="card wide" id="main" style="color:red" dir="ltr">' +
        '<input type="checkbox" checked disabled>' +
        '<table><tr><td colspan="3">x</td></tr></table></div>',
    );
    for (const structural of ['card wide', 'main', 'color:red', 'ltr', 'colspan']) {
      expect(json, structural).toContain(structural);
    }
  });

  it('leaves `display`/`visibility` untouched — masking them makes hidden content VISIBLE', async () => {
    // `display="none"` masked to `****` is invalid, so it renders as UNSET: SVG the app deliberately hid
    // became visible in the replay. A privacy failure produced by a privacy fix.
    const { json } = await drive(
      '<svg viewBox="0 0 8 8"><g display="none" visibility="hidden"><path d="M1 1 L2 2"/></g></svg>',
      { blockAllMedia: false },
    );
    expect(json).toContain('"display":"none"');
    expect(json).toContain('"visibility":"hidden"');
  });

  it('leaves UI-STATE attributes untouched, so a modern app still replays styled', async () => {
    // `data-state`/`data-theme`/`aria-expanded` are CSS/Tailwind variant selectors (Radix, shadcn,
    // next-themes, headless UI). Masking them broke open/closed, active-nav, tab selection and whole-palette
    // theming for a DEFAULT install.
    const { json } = await drive(
      '<div data-theme="dark"><button aria-expanded="true" data-state="open" data-side="bottom">x</button></div>',
    );
    for (const kept of ['dark', 'true', 'open', 'bottom']) {
      expect(json, kept).toContain(kept);
    }
  });

  it('leaves SVG geometry untouched, so icons still draw', async () => {
    // `svg` is inside MEDIA_SELECTOR, so it is blocked (and its attributes absent) at defaults — this is
    // only observable with media un-blocked. Masking `d`/`viewBox` would silently destroy every icon.
    const { json } = await drive(
      '<svg viewBox="0 0 24 24"><path d="M4 4 L8 8" fill="#abc"/></svg>',
      {
        blockAllMedia: false,
      },
    );
    for (const structural of ['0 0 24 24', 'M4 4 L8 8', '#abc']) {
      expect(json, structural).toContain(structural);
    }
  });

  it('masks attributes on DESCENDANTS of a `.bugsee-mask` element', async () => {
    // `matches()` tests the marked element ALONE, so marking a container did nothing for the fields inside
    // it — which is how anyone would expect to use the mark, and how it reads in the docs. Every text-side
    // selector rrweb consumes is subtree-scoped; this one was not.
    const { json } = await drive(
      '<div class="bugsee-mask"><input data-ssn="123-45-6789" placeholder="SSNLABEL"></div>',
      { maskAllText: false },
    );
    expect(json).not.toContain('123-45-6789');
    expect(json).not.toContain('SSNLABEL');
  });

  it('still leaves an UNMARKED element’s attributes alone with maskAllText off', async () => {
    // The narrower rule must stay narrow: `closest()` must not become "mask everything".
    const { json } = await drive('<div><input placeholder="SEARCHLABEL"></div>', {
      maskAllText: false,
    });
    expect(json).toContain('SEARCHLABEL');
  });

  it('leaves the Bugsee marker attributes intact — they drive masking itself', async () => {
    // Asserting on the marker's VALUE, not its name: the name is emitted either way, so a bare
    // `<div data-bugsee-mask>` (empty value) cannot distinguish "passed through" from "masked to ''".
    const { json } = await drive('<div data-bugsee-mask="strict">x</div>');
    expect(json).toContain('strict');
  });
});

describe('an invalid caller selector fails CLOSED and never reaches the DOM', () => {
  it('never emits a selector the DOM cannot parse — whatever the caller passes', async () => {
    // The property that closes docs/review/replay-canvas.md SEV1 #3. rrweb's canvas manager calls its
    // block check from INSIDE the patch it installs on `HTMLCanvasElement.prototype.getContext`, and that
    // check is NOT wrapped — so a malformed selector reaching the joined string threw a DOMException out of
    // the host application's own `getContext('2d')` call, before the original method ran. Chart.js,
    // signature pads and PDF.js break outright. Every resolved selector being parseable makes that
    // unreachable at the source, which is why it is asserted as one property over all of them.
    for (const bad of ['div[', 'a:has(', '::', '[', '>', 'p((']) {
      const resolved = resolveReplayMaskingOptions({
        blockSelector: bad,
        maskTextSelector: bad,
        unmaskTextSelector: bad,
        unblockSelector: bad,
        ignoreSelector: bad,
      });
      for (const [field, selector] of Object.entries(resolved)) {
        if (typeof selector !== 'string' || selector === '') continue;
        expect(
          () => document.createDocumentFragment().querySelector(selector),
          `${field}: ${bad}`,
        ).not.toThrow();
      }
    }
  });

  it('resolves a parseable block selector for the canvas patch to consume', async () => {
    // SCOPE NOTE: the end-to-end `getContext` assertion this replaces was VACUOUS — jsdom's getContext never
    // throws (it emits a jsdomError, which also made this suite intermittently fail), and `recordCanvas` was
    // never enabled, so rrweb's canvas patch was never installed. It passed with every selector malformed.
    // The reachable property is the one asserted above: every resolved selector parses, which is what makes
    // the canvas patch's UNGUARDED `matches()` call unable to throw into the host's getContext. Asserting
    // the end-to-end behaviour needs a real browser; jsdom cannot.
    const resolved = resolveReplayMaskingOptions({ blockSelector: 'div[', blockAllCanvas: true });
    expect(() => document.createElement('div').matches(resolved.blockSelector)).not.toThrow();
    expect(resolved.blockSelector).toContain('canvas');
  });

  it('keeps media blocked when `blockSelector` is malformed', async () => {
    // One comma-joined string: a single malformed fragment made `matches()` throw for EVERY element, and
    // rrweb's bare `catch {}` returned "not blocked" — disabling blocking page-wide (SEV1 #3).
    const { json } = await drive('<img src="https://x.test/secret-photo.png">', {
      blockSelector: 'div[',
    });
    expect(json).not.toContain('secret-photo.png');
  });

  it('keeps text masked, and does NOT abort the snapshot, when `unmaskTextSelector` is malformed', async () => {
    // Here rrweb's `matches()` is NOT guarded: the SyntaxError escaped into the host page and aborted the
    // full snapshot, so replay silently produced an unusable stream (SEV2 #10).
    const { json, events } = await drive('<div>VISIBLESECRET</div>', {
      unmaskTextSelector: 'div[',
    });
    expect(events.some((e) => e.type === SNAPSHOT_EVENT)).toBe(true);
    expect(json).not.toContain('VISIBLESECRET');
  });

  it('keeps masking when `maskTextSelector` is malformed and maskAllText was turned off', async () => {
    // Dropping the fragment alone would fail OPEN here — the caller's masking intent would just vanish — so
    // an unparseable mask selector escalates back to masking everything.
    const { json } = await drive('<div>VISIBLESECRET</div>', {
      maskAllText: false,
      maskTextSelector: 'div[',
    });
    expect(json).not.toContain('VISIBLESECRET');
  });

  it('re-blocks all media when `blockSelector` is malformed and blockAllMedia was turned off', async () => {
    // The escalation only bites here. With blockAllMedia left at its default the built-in set already
    // covers the image, so a test at defaults passes whether or not the escalation exists.
    const { json } = await drive('<img src="https://x.test/secret-photo.png">', {
      blockAllMedia: false,
      blockSelector: 'div[',
    });
    expect(json).not.toContain('secret-photo.png');
  });

  it('re-masks all inputs when `ignoreSelector` is malformed and maskAllInputs was turned off', async () => {
    // `ignoreSelector` is an opt-IN privacy control too — it names inputs whose events must not be
    // recorded. If it cannot be parsed, the safe reading is that the caller wanted more privacy, not less.
    const { json } = await drive('<input value="INPUTSECRET">', {
      maskAllInputs: false,
      ignoreSelector: 'div[',
    });
    expect(json).not.toContain('INPUTSECRET');
  });

  it('reports the invalid selector instead of failing silently', async () => {
    const errors: unknown[] = [];
    resolveReplayMaskingOptions({ blockSelector: 'div[' }, { onError: (e) => errors.push(e) });
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('blockSelector');
  });
});

describe('masking cannot be downgraded by prototype pollution or a non-boolean', () => {
  afterEach(() => {
    for (const key of ['maskAllText', 'maskAllInputs', 'blockAllMedia']) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  it('ignores a polluted `Object.prototype.maskAllText`', async () => {
    (Object.prototype as Record<string, unknown>).maskAllText = false;
    const { json } = await drive('<div>VISIBLESECRET</div>');
    expect(json).not.toContain('VISIBLESECRET');
  });

  it('ignores a polluted `Object.prototype.blockAllMedia`', async () => {
    (Object.prototype as Record<string, unknown>).blockAllMedia = false;
    const { json } = await drive('<img src="https://x.test/secret-photo.png">');
    expect(json).not.toContain('secret-photo.png');
  });

  it('ignores a falsy NON-boolean, which rrweb would otherwise read as "off"', async () => {
    const { json } = await drive('<div>VISIBLESECRET</div>', {
      maskAllText: 0 as unknown as boolean,
    });
    expect(json).not.toContain('VISIBLESECRET');
  });
});
