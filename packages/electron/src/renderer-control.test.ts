import { describe, expect, it, vi } from 'vitest';
import { encodeControl } from './protocol';
import { createRendererControlHandler } from './renderer-control';

function harness(over: Partial<Parameters<typeof createRendererControlHandler>[0]> = {}) {
  const calls = {
    setPaused: vi.fn(),
    stop: vi.fn(),
    onSession: vi.fn(),
    flush: vi.fn(),
    onBlackout: vi.fn(),
  };
  const handle = createRendererControlHandler({ ...calls, ...over });
  return { ...calls, handle };
}

describe('createRendererControlHandler', () => {
  it('pause → setPaused(true)', () => {
    const h = harness();
    h.handle(encodeControl({ command: 'pause' }));
    expect(h.setPaused).toHaveBeenCalledWith(true);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it('resume → setPaused(false)', () => {
    const h = harness();
    h.handle(encodeControl({ command: 'resume' }));
    expect(h.setPaused).toHaveBeenCalledWith(false);
  });

  it('flush() → flush', () => {
    const h = harness();
    h.handle(encodeControl({ command: 'flush' }));
    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(h.setPaused).not.toHaveBeenCalled();
  });

  it('stop() → stop', () => {
    const h = harness();
    h.handle(encodeControl({ command: 'stop' }));
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it('session → onSession(sessionId)', () => {
    const h = harness();
    h.handle(encodeControl({ command: 'session', sessionId: 'sess-9' }));
    expect(h.onSession).toHaveBeenCalledWith('sess-9');
  });

  it('session without a sessionId does not call onSession', () => {
    const h = harness();
    h.handle(encodeControl({ command: 'session' }));
    expect(h.onSession).not.toHaveBeenCalled();
  });

  it('blackout-start / blackout-end → onBlackout(true / false)', () => {
    const h = harness();
    h.handle(encodeControl({ command: 'blackout-start' }));
    expect(h.onBlackout).toHaveBeenLastCalledWith(true);
    h.handle(encodeControl({ command: 'blackout-end' }));
    expect(h.onBlackout).toHaveBeenLastCalledWith(false);
    expect(h.onBlackout).toHaveBeenCalledTimes(2);
    expect(h.setPaused).not.toHaveBeenCalled();
  });

  it('a session reply carrying the blackout state applies it BEFORE the session id releases the launch hold', () => {
    const order: string[] = [];
    const h = harness({
      onSession: () => order.push('session'),
      onBlackout: (active: boolean) => order.push(`blackout:${active}`),
    });
    h.handle(encodeControl({ command: 'session', sessionId: 's', blackout: true }));
    h.handle(encodeControl({ command: 'session', sessionId: 's', blackout: false }));
    expect(order).toEqual(['blackout:true', 'session', 'blackout:false', 'session']);
  });

  it('a session reply WITHOUT a blackout flag does not touch the blackout', () => {
    const h = harness();
    h.handle(encodeControl({ command: 'session', sessionId: 's' }));
    expect(h.onBlackout).not.toHaveBeenCalled();
  });

  it('tolerates an absent onBlackout', () => {
    const h = harness({ onBlackout: undefined });
    expect(() => h.handle(encodeControl({ command: 'blackout-start' }))).not.toThrow();
    expect(() =>
      h.handle(encodeControl({ command: 'session', sessionId: 's', blackout: true })),
    ).not.toThrow();
  });

  it('ignores an invalid / non-control message', () => {
    const h = harness();
    h.handle('<<not json>>');
    h.handle(JSON.stringify({ k: 'entry' }));
    expect(h.setPaused).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.onSession).not.toHaveBeenCalled();
    expect(h.flush).not.toHaveBeenCalled();
  });

  it('tolerates absent optional callbacks (flush/onSession)', () => {
    const h = harness({ flush: undefined, onSession: undefined });
    expect(() => h.handle(encodeControl({ command: 'flush' }))).not.toThrow();
    expect(() => h.handle(encodeControl({ command: 'session', sessionId: 's' }))).not.toThrow();
  });
});
