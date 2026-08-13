import { describe, expect, it, vi } from 'vitest';
import { createBridgeControl } from './host-bridge-control';
import { type ControlMessage, PROTOCOL_VERSION } from './protocol';

const reply = (m: Omit<ControlMessage, 'k' | 'b'>): string =>
  JSON.stringify({ b: PROTOCOL_VERSION, k: 'control', ...m });

describe('createBridgeControl', () => {
  // D-A10 — a NATIVE-minted secret closes the channel from the first message.
  //
  // `token` (D-A1) is minted by JS and published in `hello`, which means a page script can mint one too and
  // native cannot tell the two apart. It is why the channel has to start OPEN and wait to latch: until a
  // correctly-tokened message proves native speaks the new protocol, nothing can be rejected. During that
  // window — and FOREVER when `mintControlToken` returns undefined because no CSPRNG is present — a page
  // script can call `__bugsee_bridge.control(...)` with `cmd:"stop"` and switch the customer's capture off.
  //
  // A native-minted secret has no such window. Native already knows it before the first message, so an
  // untokened or wrongly-tokened control message is an attack from the outset, not a legacy receiver.
  describe('with a native-minted secret', () => {
    it('rejects an untokened control message immediately — there is no open period', () => {
      const onCommand = vi.fn();
      const bc = createBridgeControl({ onCommand, nativeSecret: 'from-native' });

      bc.control(reply({ command: 'stop' }));

      expect(onCommand).not.toHaveBeenCalled();
    });

    it('rejects a wrongly-tokened control message', () => {
      const onCommand = vi.fn();
      const bc = createBridgeControl({ onCommand, nativeSecret: 'from-native' });

      bc.control(reply({ command: 'stop', tok: 'guessed' } as never));

      expect(onCommand).not.toHaveBeenCalled();
    });

    it('admits a control message carrying the native secret', () => {
      const onCommand = vi.fn();
      const bc = createBridgeControl({ onCommand, nativeSecret: 'from-native' });

      bc.control(reply({ command: 'stop', tok: 'from-native' } as never));

      expect(onCommand).toHaveBeenCalledWith('stop');
    });

    it('stays closed after a rejection — a wrong token cannot re-open the channel', () => {
      const onCommand = vi.fn();
      const bc = createBridgeControl({ onCommand, nativeSecret: 'from-native' });

      bc.control(reply({ command: 'stop', tok: 'guessed' } as never));
      bc.control(reply({ command: 'pause' })); // untokened, after the failed attempt

      expect(onCommand).not.toHaveBeenCalled();
    });
  });

  it('defaults reportTrigger to false (D5) with no native session yet', () => {
    const bc = createBridgeControl();
    expect(bc.config).toEqual({ reportTrigger: false });
  });

  it('seeds reportTrigger from the launch option', () => {
    expect(createBridgeControl({ reportTrigger: true }).config.reportTrigger).toBe(true);
  });

  it('applies the native session id from a control reply', () => {
    const bc = createBridgeControl();
    bc.control(reply({ session: 'native-7' }));
    expect(bc.config.session).toBe('native-7');
  });

  it('lets native override reportTrigger via the config push', () => {
    const bc = createBridgeControl({ reportTrigger: true });
    bc.control(reply({ config: { reportTrigger: false } }));
    expect(bc.config.reportTrigger).toBe(false);
  });

  it('routes a command to onCommand (slice-3 seam)', () => {
    const onCommand = vi.fn();
    const bc = createBridgeControl({ onCommand });
    bc.control(reply({ command: 'flush' }));
    expect(onCommand).toHaveBeenCalledWith('flush');
  });

  it('ignores a command when no onCommand handler is wired (no throw)', () => {
    const bc = createBridgeControl();
    expect(() => bc.control(reply({ command: 'pause' }))).not.toThrow();
  });

  it('ignores a non-control / non-JSON message and leaves config unchanged (no throw)', () => {
    const bc = createBridgeControl({ reportTrigger: true });
    bc.control('not json {');
    bc.control(JSON.stringify({ k: 'entry' })); // foreign kind on a shared channel
    expect(bc.config).toEqual({ reportTrigger: true }); // untouched
  });

  it('accepts a bare reply (no session/config/command) without changing anything', () => {
    const bc = createBridgeControl();
    bc.control(reply({}));
    expect(bc.config).toEqual({ reportTrigger: false });
  });

  it('retains a previously-set session across a later config-only reply (no clobber)', () => {
    const bc = createBridgeControl();
    bc.control(reply({ session: 'native-1' }));
    bc.control(reply({ config: { reportTrigger: true } })); // no session field → must NOT clear it
    expect(bc.config.session).toBe('native-1');
    expect(bc.config.reportTrigger).toBe(true);
  });
});

// WAVE 0.3 / D-A1 + D-A2 — the inbound control channel is authenticated by a per-session token.
//
// SEV1-4(a): `parseControl` authenticated NOTHING, so any script in the page could call
// `__bugsee_bridge.control('{"b":1,"k":"control","command":"pause"}')` to silently stop capture, or
// `"stop"` to tear the SDK down permanently — with nothing logged and native never told the pause was not
// its own. Closing the binding (D-A3) stops the object being REPLACED; it does not stop it being CALLED.
//
// The token is minted in JS and published once, on `hello` (D-A1). It is deliberately never repeated on
// later outbound messages: that is precisely what stops a script which taps the bridge AFTER launch — the
// real SEV1-3 threat, an ad tag loading late — from ever learning it.
//
// Enforcement is a ONE-WAY UPGRADE (D-A2) because no shipped native receiver echoes a token yet. The
// channel starts unauthenticated (today's behaviour, no breakage), and the first correctly-tokened message
// flips it closed forever. A page script cannot force the flip (it needs the token) nor undo it.
describe('createBridgeControl — token authentication (Wave 0.3)', () => {
  const TOKEN = 'tok-abc123';
  const raw = (msg: Record<string, unknown>): string =>
    JSON.stringify({ b: 1, k: 'control', ...msg });

  it('accepts untokened control BEFORE any authenticated message — a legacy receiver still works', () => {
    const onCommand = vi.fn();
    const control = createBridgeControl({ token: TOKEN, onCommand });
    control.control(raw({ command: 'pause' }));
    expect(onCommand).toHaveBeenCalledWith('pause');
  });

  it('accepts a correctly-tokened message', () => {
    const onCommand = vi.fn();
    const control = createBridgeControl({ token: TOKEN, onCommand });
    control.control(raw({ tok: TOKEN, command: 'flush' }));
    expect(onCommand).toHaveBeenCalledWith('flush');
  });

  it('REJECTS untokened control once the channel has upgraded', () => {
    const onCommand = vi.fn();
    const control = createBridgeControl({ token: TOKEN, onCommand });
    control.control(raw({ tok: TOKEN, command: 'flush' })); // upgrade
    onCommand.mockClear();

    control.control(raw({ command: 'stop' })); // the page-script attack
    expect(
      onCommand,
      'a page script stopped the SDK after the channel was authenticated',
    ).not.toHaveBeenCalled();
  });

  it('keeps accepting tokened control AFTER the latch arms — native is not locked out', () => {
    // Round 1, SEV1: every tokened test sent exactly ONE message, so `if (tok === token &&
    // !authenticated)` — one word — locked native permanently out of its own channel and the whole suite
    // stayed green. Native sends many control messages per session (pause on background, flush before a
    // frame, stop on teardown); the second must work as well as the first.
    const onCommand = vi.fn();
    const control = createBridgeControl({ token: TOKEN, onCommand });
    control.control(raw({ tok: TOKEN, command: 'flush' })); // arms the latch
    onCommand.mockClear();
    control.control(raw({ tok: TOKEN, command: 'pause' }));
    expect(onCommand, 'native was locked out after its first tokened message').toHaveBeenCalledWith(
      'pause',
    );
  });

  it('rejects a WRONG token even before the upgrade — a guess must never be treated as legacy', () => {
    // The subtle failure mode: "no token means legacy" must not become "any token I do not recognise means
    // legacy". A present-but-wrong token is an attack, not an old receiver.
    const onCommand = vi.fn();
    const control = createBridgeControl({ token: TOKEN, onCommand });
    control.control(raw({ tok: 'guessed', command: 'stop' }));
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('does not apply CONFIG from a rejected message either, not just commands', () => {
    // Suppression is the headline, but config is the quieter one: flipping `reportTrigger` from the page
    // makes the WebView open native bug reports at will (the D5 gate).
    const control = createBridgeControl({ token: TOKEN, reportTrigger: false });
    control.control(raw({ tok: TOKEN, command: 'flush' })); // upgrade
    control.control(raw({ config: { reportTrigger: true }, session: 'hijacked' }));
    expect(control.config.reportTrigger).toBe(false);
    expect(control.config.session).toBeUndefined();
  });

  it('the upgrade is ONE-WAY — an untokened message cannot downgrade it', () => {
    const onCommand = vi.fn();
    const control = createBridgeControl({ token: TOKEN, onCommand });
    control.control(raw({ tok: TOKEN, command: 'flush' })); // upgrade
    control.control(raw({ command: 'pause' })); // rejected, and must not relax the channel
    onCommand.mockClear();
    control.control(raw({ command: 'pause' }));
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('reports a rejected message through onError so a hijack attempt is visible', () => {
    const onError = vi.fn();
    const control = createBridgeControl({ token: TOKEN, onError });
    control.control(raw({ tok: TOKEN, command: 'flush' })); // upgrade
    control.control(raw({ command: 'stop' }));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toMatch(/control/i);
  });

  it('stays permanently open when NO token was minted — the channel cannot upgrade at all', () => {
    // The pre-token launch path (and every test above that omits `token`). Without a secret there is
    // nothing to authenticate against, so enforcing would lock native out entirely.
    const onCommand = vi.fn();
    const control = createBridgeControl({ onCommand });
    control.control(raw({ tok: 'anything', command: 'pause' }));
    control.control(raw({ command: 'resume' }));
    expect(onCommand).toHaveBeenNthCalledWith(1, 'pause');
    expect(onCommand).toHaveBeenNthCalledWith(2, 'resume');
  });
});

// WAVE 0.3 review round 1 — the rejection report is itself page-reachable, so it needs the same treatment
// as any other host callback.
describe('createBridgeControl — the rejection report is contained and bounded', () => {
  const TOKEN = 'tok-abc123';
  const raw = (msg: Record<string, unknown>): string =>
    JSON.stringify({ b: 1, k: 'control', ...msg });

  const upgraded = (over: Parameters<typeof createBridgeControl>[0] = {}) => {
    const control = createBridgeControl({ token: TOKEN, ...over });
    control.control(raw({ tok: TOKEN, command: 'flush' })); // arm the latch
    return control;
  };

  it('does not let a THROWING onError escape into evaluateJavascript', () => {
    // `control()` is called by native through `evaluateJavascript`. An exception crossing that boundary is
    // the SEV1-1 fail-open shape (native gets an error instead of a result at frame-capture time), and
    // `onError` is arbitrary host code — a dev-mode assert, a logger with a throwing toJSON.
    const control = upgraded({
      onError: () => {
        throw new Error('host sink exploded');
      },
    });
    expect(() => control.control(raw({ command: 'stop' }))).not.toThrow();
  });

  it('reports at most ONCE, however many times the page calls it', () => {
    // A page script can loop on `__bugsee_bridge.control(...)`, allocating an Error per call into the
    // host's error sink. D-A4 refused to report sink swaps for precisely this reason; the same rule has
    // to hold here or the two decisions in one wave contradict each other.
    const onError = vi.fn();
    const control = upgraded({ onError });
    for (let i = 0; i < 50; i++) {
      control.control(raw({ command: 'pause' }));
    }
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('still REJECTS every one of those messages, not just the first', () => {
    // The canary for the rate limit: capping the report must not cap the enforcement.
    const onCommand = vi.fn();
    const control = upgraded({ onCommand });
    onCommand.mockClear();
    for (let i = 0; i < 5; i++) {
      control.control(raw({ command: 'stop' }));
    }
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('shares a caller-owned latch, so a second handler inherits it', () => {
    // What makes the latch survive a page-forced relaunch: the state belongs to the global, not to one
    // handler instance.
    const auth = { authenticated: false };
    const first = createBridgeControl({ token: TOKEN, auth });
    first.control(raw({ tok: TOKEN, command: 'flush' }));
    expect(auth.authenticated).toBe(true);

    const onCommand = vi.fn();
    const second = createBridgeControl({ token: 'a-different-token', auth, onCommand });
    second.control(raw({ command: 'pause' })); // untokened, page-issued
    expect(onCommand, 'a fresh handler started un-latched').not.toHaveBeenCalled();
  });
});
