import { describe, expect, it, vi } from 'vitest';
import { createBridgeControl } from './host-bridge-control';
import type { ControlMessage } from './protocol';

const reply = (m: Omit<ControlMessage, 'k'>): string => JSON.stringify({ k: 'control', ...m });

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
