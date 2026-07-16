import { describe, expect, it, vi } from 'vitest';
import { encodeControl } from './protocol';
import { createRendererControlHandler } from './renderer-control';

function harness(over: Partial<Parameters<typeof createRendererControlHandler>[0]> = {}) {
  const calls = {
    setPaused: vi.fn(),
    stop: vi.fn(),
    onSession: vi.fn(),
    flush: vi.fn(),
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

  it('flush → flush()', () => {
    const h = harness();
    h.handle(encodeControl({ command: 'flush' }));
    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(h.setPaused).not.toHaveBeenCalled();
  });

  it('stop → stop()', () => {
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
