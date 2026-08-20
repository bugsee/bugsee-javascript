import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveReplayMaskingOptions } from './masking';

/**
 * Property-based tests for replay masking — the SDK's largest privacy surface.
 *
 * Session replay records the DOM continuously, so this resolver decides what a customer's support team
 * can see of an end user's screen. Its own header records three ways "fail-closed" turned out not to be
 * true in practice (docs/review/replay.md SEV1 #1/#2/#3), and each of those was a specific option
 * combination nobody had written a case for. That is precisely what a property covers and an example
 * cannot.
 *
 * The properties below are asserted against a REAL DOM (`matches()`), because the guarantees are about
 * what the browser will match, not about the strings we build.
 */

/** Every input the floor must always cover, as real elements. */
const SENSITIVE_INPUTS: ReadonlyArray<{ label: string; html: string }> = [
  { label: 'type=password', html: '<input type="password">' },
  { label: 'type=PASSWORD (case)', html: '<input type="PASSWORD">' },
  { label: 'type=tel', html: '<input type="tel">' },
  { label: 'autocomplete=current-password', html: '<input autocomplete="current-password">' },
  { label: 'autocomplete=new-password', html: '<input autocomplete="new-password">' },
  { label: 'autocomplete=cc-number', html: '<input autocomplete="cc-number">' },
  { label: 'autocomplete=cc-csc', html: '<input autocomplete="cc-csc">' },
  { label: 'autocomplete=one-time-code', html: '<input autocomplete="one-time-code">' },
  // Spec-valid token list — the documented WebAuthn-assisted OTP pairing, which the `=` form missed.
  {
    label: 'autocomplete="webauthn one-time-code"',
    html: '<input autocomplete="webauthn one-time-code">',
  },
  { label: 'data-rr-is-password (rrweb’s own memory)', html: '<input data-rr-is-password>' },
];

/** Build a detached element from HTML so `matches()` can be asked about it. */
const element = (html: string, extraClass?: string): Element => {
  const host = document.createElement('div');
  host.innerHTML = html;
  const el = host.firstElementChild as Element;
  if (extraClass !== undefined) {
    el.setAttribute('class', extraClass);
  }
  return el;
};

/** Arbitrary caller options, including the shapes that historically defeated the defaults. */
const callerOptions = fc.record(
  {
    maskAllText: fc.oneof(fc.boolean(), fc.constantFrom<unknown>(0, 1, '', 'false', null)),
    maskAllInputs: fc.oneof(fc.boolean(), fc.constantFrom<unknown>(0, 1, '', 'false', null)),
    blockAllMedia: fc.oneof(fc.boolean(), fc.constantFrom<unknown>(0, 1, '', 'false', null)),
    blockAllCanvas: fc.boolean(),
    maskTextSelector: fc.constantFrom('.a', '#b', '[data-x]', '*', 'div span'),
    unmaskTextSelector: fc.constantFrom('.a', '*', '[data-y]', 'input', '.bugsee-unmask'),
    unblockSelector: fc.constantFrom('.a', '*', 'img'),
    blockSelector: fc.constantFrom('.a', 'video'),
    ignoreSelector: fc.constantFrom('.a', 'input'),
  },
  { requiredKeys: [] },
) as fc.Arbitrary<Record<string, unknown>>;

describe('the sensitive-input floor (fuzz)', () => {
  /**
   * THE hard floor: whatever the options say, and whatever the markup says, a sensitive input can never
   * match the un-mask selector.
   *
   * This is SEV1 #1. rrweb resolves an input's value as
   * `unmaskInputSelector.matches(el) ? raw : maskInputValue(…)` — the un-mask check comes FIRST and
   * short-circuits, so `maskInputOptions:{password:true}` is never consulted for an un-masked element.
   * Feeding the caller's text un-mask selector into the input path therefore voided "passwords are always
   * masked" outright, and `unmaskTextSelector: '*'` un-masked every password on the page.
   */
  it('never lets a sensitive input match the un-mask selector, for any options', () => {
    fc.assert(
      fc.property(callerOptions, (options) => {
        const resolved = resolveReplayMaskingOptions(options);
        for (const { label, html } of SENSITIVE_INPUTS) {
          // Including when the app has explicitly marked it un-masked — the mark must not lift the floor.
          for (const cls of [undefined, 'bugsee-unmask']) {
            const el = element(html, cls);
            expect(
              el.matches(resolved.unmaskInputSelector),
              `${label}${cls ? ' + .bugsee-unmask' : ''} matched the un-mask selector`,
            ).toBe(false);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Sensitive inputs also have their input EVENTS ignored, whatever the options.
   *
   * `maskInputOptions` is keyed by input TYPE, so it cannot name a field declared sensitive by
   * `autocomplete`; with `maskAllInputs:false` the live observer emitted raw `cc-number`,
   * `one-time-code` and `current-password` values. Not recording their events at all closes that.
   */
  it('always ignores input events from a sensitive field', () => {
    fc.assert(
      fc.property(callerOptions, (options) => {
        const resolved = resolveReplayMaskingOptions(options);
        for (const { label, html } of SENSITIVE_INPUTS) {
          expect(
            element(html).matches(resolved.ignoreSelector),
            `${label} was not in the ignore set`,
          ).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  // The floor rrweb consults when it DOES mask must name every sensitive type, since the live observer
  // gates on this map alone and never re-derives the rules.
  it('always declares the sensitive input types to rrweb', () => {
    fc.assert(
      fc.property(callerOptions, (options) => {
        const resolved = resolveReplayMaskingOptions(options);
        expect(resolved.maskInputOptions).toMatchObject({ password: true, tel: true });
      }),
      { numRuns: 200 },
    );
  });
});

describe('fail-closed defaults (fuzz)', () => {
  afterEach(() => {
    for (const key of ['maskAllText', 'maskAllInputs', 'blockAllMedia']) {
      delete (Object.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  /**
   * A non-boolean never disables masking. `maskAllText: 0` used to reach rrweb as `0`, which it reads as
   * "off" — a config typo silently turning replay into a plaintext recording.
   */
  it('treats a non-boolean option as the fail-closed default', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<unknown>(0, 1, '', 'false', 'true', null, [], {}, Number.NaN),
        (value) => {
          const resolved = resolveReplayMaskingOptions({
            maskAllText: value,
            maskAllInputs: value,
            blockAllMedia: value,
          } as never);
          expect(resolved.maskAllText, `maskAllText was disabled by ${String(value)}`).toBe(true);
          expect(resolved.maskAllInputs).toBe(true);
          // blockAllMedia is expressed through the block selector.
          expect(document.createElement('img').matches(resolved.blockSelector)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * A page-wide prototype gadget must not downgrade the defaults. `options.x ?? default` walks the
   * prototype chain, so `Object.prototype.maskAllText = false` silently turned every install fail-open.
   */
  it('ignores a value planted on Object.prototype', () => {
    fc.assert(
      fc.property(fc.constantFrom('maskAllText', 'maskAllInputs', 'blockAllMedia'), (key) => {
        (Object.prototype as unknown as Record<string, unknown>)[key] = false;
        const resolved = resolveReplayMaskingOptions({});
        expect(resolved.maskAllText, `${key} gadget downgraded masking`).toBe(true);
        expect(resolved.maskAllInputs).toBe(true);
        expect(document.createElement('img').matches(resolved.blockSelector)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('masks and blocks everything when given no options at all', () => {
    for (const options of [undefined, {}, null as never]) {
      const resolved = resolveReplayMaskingOptions(options);
      expect(resolved.maskAllText).toBe(true);
      expect(resolved.maskAllInputs).toBe(true);
      for (const tag of ['img', 'video', 'iframe', 'audio', 'embed']) {
        expect(
          document.createElement(tag).matches(resolved.blockSelector),
          `${tag} was not blocked by default`,
        ).toBe(true);
      }
    }
  });
});

describe('selector safety (fuzz)', () => {
  /**
   * Every selector this resolver emits must PARSE.
   *
   * Selectors are comma-joined into one string, and rrweb's `catch {}` answers "not blocked" when
   * `matches()` throws — so a single unparseable fragment silently disables blocking page-wide. That is
   * SEV1 #3.
   */
  it('always emits parseable selectors', () => {
    fc.assert(
      fc.property(callerOptions, (options) => {
        const resolved = resolveReplayMaskingOptions(options);
        const probe = document.createElement('div');
        for (const key of [
          'maskTextSelector',
          'unmaskTextSelector',
          'unmaskInputSelector',
          'unblockSelector',
          'blockSelector',
          'ignoreSelector',
        ] as const) {
          expect(() => probe.matches(resolved[key]), `${key} does not parse`).not.toThrow();
        }
      }),
      { numRuns: 400 },
    );
  });

  /**
   * An INVALID caller selector is dropped and reported — and where dropping would itself weaken privacy,
   * the setting escalates to the strictest instead of quietly losing the caller's intent.
   */
  it('escalates to the strictest setting when an opt-IN selector is unparseable', () => {
    fc.assert(
      // Selectors this ENVIRONMENT rejects. jsdom's engine (nwsapi) is more permissive than a browser —
      // it accepts `div:has(` and `[unclosed`, which Chromium rejects, so the set is chosen by what
      // `matches()` actually throws on here. The module records the same divergence in the other
      // direction (`div:has(:has(div))` passes querySelector and throws in matches()).
      fc.property(fc.constantFrom(':::bad', 'a..b', '[a=]', '::::', 'div:::x', '@@@'), (bad) => {
        const errors: unknown[] = [];
        const resolved = resolveReplayMaskingOptions(
          { maskAllText: false, maskTextSelector: bad },
          { onError: (e) => errors.push(e) },
        );
        // Masking intent could not be honoured precisely, so everything is masked.
        expect(resolved.maskAllText, 'an invalid mask selector was silently dropped').toBe(true);
        expect(errors.length, 'the invalid selector was not reported').toBeGreaterThan(0);
        expect(() =>
          document.createElement('div').matches(resolved.maskTextSelector),
        ).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('still parses when an opt-OUT selector is unparseable, and reports it', () => {
    fc.assert(
      fc.property(fc.constantFrom(':::bad', 'a..b', '[a=]', '::::'), (bad) => {
        const errors: unknown[] = [];
        const resolved = resolveReplayMaskingOptions(
          { unmaskTextSelector: bad, unblockSelector: bad },
          { onError: (e) => errors.push(e) },
        );
        const probe = document.createElement('div');
        expect(() => probe.matches(resolved.unmaskTextSelector)).not.toThrow();
        expect(() => probe.matches(resolved.unblockSelector)).not.toThrow();
        expect(errors.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });
});

describe('attribute masking (fuzz)', () => {
  /**
   * The attribute allowlist. A denylist over an open namespace is fail-OPEN by construction — every
   * `data-*`, `<meta content>` and bespoke attribute shipped in the clear at DEFAULTS (SEV1 #2).
   */
  it('masks any attribute that is not rendering-critical, preserving length', () => {
    const { maskAttributeFn } = resolveReplayMaskingOptions({});
    fc.assert(
      fc.property(
        fc.stringMatching(/^data-(user|customer|ssn|email|token)[a-z-]{0,10}$/),
        fc.stringMatching(/^[a-zA-Z0-9@. _-]{1,40}$/),
        (name, value) => {
          const masked = (maskAttributeFn as (k: string, v: string) => string)(name, value);
          expect(masked, `${name} leaked its value`).not.toBe(value);
          expect(masked).toBe('*'.repeat(value.length)); // length preserved so layout is unaffected
        },
      ),
      { numRuns: 400 },
    );
  });

  /**
   * ...and the inverse: rendering-critical attributes pass through. Masking these does not merely lose
   * fidelity — `display`/`visibility` masked to `****` read as invalid and render as UNSET, so content the
   * app deliberately hid became VISIBLE in the replay. A privacy failure produced by a privacy fix.
   */
  it('passes rendering-critical attributes through untouched', () => {
    const { maskAttributeFn } = resolveReplayMaskingOptions({});
    const structural = [
      'display',
      'visibility',
      'class',
      'id',
      'style',
      'd',
      'fill',
      'viewbox',
      'width',
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...structural),
        fc.stringMatching(/^[a-zA-Z0-9 .-]{1,20}$/),
        (name, value) => {
          expect((maskAttributeFn as (k: string, v: string) => string)(name, value)).toBe(value);
          // Case-insensitively, since HTML attribute names are.
          expect(
            (maskAttributeFn as (k: string, v: string) => string)(name.toUpperCase(), value),
          ).toBe(value);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Bugsee's own marks must pass through: they DRIVE masking, so masking them would disable it.
  it('never masks the marks that drive masking', () => {
    const { maskAttributeFn } = resolveReplayMaskingOptions({});
    for (const name of ['data-bugsee-mask', 'data-bugsee-block', 'data-rr-is-password']) {
      expect((maskAttributeFn as (k: string, v: string) => string)(name, 'true')).toBe('true');
    }
  });
});

/**
 * The EXPLICIT-MARK path, used when `maskAllText` is off.
 *
 * `.bugsee-mask` is documented and used as a SUBTREE instruction — marking a container is how anyone
 * would wrap a form — but the resolver originally tested the marked element ALONE, so
 * `<div class="bugsee-mask"><input data-ssn="…"></div>` masked nothing. Mutation testing showed the whole
 * path unasserted: it only runs with `maskAllText:false`, which no other property here selects.
 */
describe('explicit mark subtree masking (fuzz)', () => {
  /** Build `<mark><child data-x="secret"></mark>` and ask the resolver about the CHILD. */
  const underMark = (markClass: string | undefined, childClass?: string): Element => {
    const wrapper = document.createElement('div');
    if (markClass !== undefined) {
      wrapper.setAttribute('class', markClass);
    }
    const child = document.createElement('span');
    if (childClass !== undefined) {
      child.setAttribute('class', childClass);
    }
    wrapper.append(child);
    return child;
  };

  const maskerFor = (): ((key: string, value: string, el: unknown) => string) => {
    const { maskAttributeFn } = resolveReplayMaskingOptions({ maskAllText: false });
    return maskAttributeFn as (key: string, value: string, el: unknown) => string;
  };

  it('masks a descendant’s attributes when an ANCESTOR carries the mark', () => {
    const mask = maskerFor();
    fc.assert(
      fc.property(
        fc.constantFrom('bugsee-mask', 'other bugsee-mask'),
        fc.stringMatching(/^[a-zA-Z0-9@._-]{1,30}$/),
        (markClass, value) => {
          const child = underMark(markClass);
          expect(mask('data-ssn', value, child), 'a marked SUBTREE leaked an attribute').not.toBe(
            value,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('leaves attributes alone when nothing is marked', () => {
    const mask = maskerFor();
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9@._-]{1,30}$/), (value) => {
        expect(mask('data-ssn', value, underMark(undefined))).toBe(value);
      }),
      { numRuns: 200 },
    );
  });

  // Nearest mark wins, matching how text resolves `.bugsee-unmask` against `.bugsee-mask`.
  it('lets a NEARER un-mask win over an outer mask', () => {
    const mask = maskerFor();
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9@._-]{1,30}$/), (value) => {
        const child = underMark('bugsee-mask', 'bugsee-unmask');
        expect(mask('data-ssn', value, child)).toBe(value);
      }),
      { numRuns: 200 },
    );
  });

  // An element that cannot be walked fails CLOSED — an unreadable DOM must not become an unmasked one.
  it('masks when the element cannot be inspected', () => {
    const mask = maskerFor();
    const hostile = {
      closest: () => {
        throw new Error('closest exploded');
      },
    };
    expect(mask('data-ssn', 'secret-value', hostile)).not.toBe('secret-value');
    expect(mask('data-ssn', 'secret-value', null)).toBe('secret-value'); // no element → no mark → untouched
  });
});
