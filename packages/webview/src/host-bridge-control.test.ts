import { describe, expect, it, vi } from 'vitest';
import { createBridgeControl } from './host-bridge-control';
import { type ControlMessage, PROTOCOL_VERSION } from './protocol';

const reply = (m: Omit<ControlMessage, 'k' | 'b'>): string =>
  JSON.stringify({ b: PROTOCOL_VERSION, k: 'control', ...m });

describe('createBridgeControl', () => {
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
