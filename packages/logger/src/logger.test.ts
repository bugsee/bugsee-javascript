import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './index';

describe('createLogger', () => {
  it('defaults to the "error" level', () => {
    expect(createLogger().getLevel()).toBe('error');
  });

  it('honors an explicit initial level', () => {
    expect(createLogger('debug').getLevel()).toBe('debug');
  });

  it('setLevel updates the level', () => {
    const log = createLogger();
    log.setLevel('info');
    expect(log.getLevel()).toBe('info');
  });

  it('emits error at the default level with (level, args)', () => {
    const log = createLogger();
    const handler = vi.fn();
    log.addHandler(handler);
    log.error('boom', 1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('error', ['boom', 1]);
  });

  it('suppresses warn at the "error" level and emits it at "warn"', () => {
    const log = createLogger('error');
    const handler = vi.fn();
    log.addHandler(handler);
    log.warn('x');
    expect(handler).not.toHaveBeenCalled();
    log.setLevel('warn');
    log.warn('y');
    expect(handler).toHaveBeenCalledWith('warn', ['y']);
  });

  it('emits info only at "info" or more verbose', () => {
    const log = createLogger('warn');
    const handler = vi.fn();
    log.addHandler(handler);
    log.info('a');
    expect(handler).not.toHaveBeenCalled();
    log.setLevel('info');
    log.info('b');
    expect(handler).toHaveBeenCalledWith('info', ['b']);
  });

  it('emits debug only at "debug"', () => {
    const log = createLogger('info');
    const handler = vi.fn();
    log.addHandler(handler);
    log.debug('a');
    expect(handler).not.toHaveBeenCalled();
    log.setLevel('debug');
    log.debug('b');
    expect(handler).toHaveBeenCalledWith('debug', ['b']);
  });

  it('"silent" suppresses everything, including error', () => {
    const log = createLogger('silent');
    const handler = vi.fn();
    log.addHandler(handler);
    log.error('nope');
    expect(handler).not.toHaveBeenCalled();
  });

  it('addHandler returns an unsubscribe that stops delivery', () => {
    const log = createLogger();
    const handler = vi.fn();
    const off = log.addHandler(handler);
    log.error('1');
    off();
    log.error('2');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('delivers to every registered handler', () => {
    const log = createLogger();
    const a = vi.fn();
    const b = vi.fn();
    log.addHandler(a);
    log.addHandler(b);
    log.error('z');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('warnOnce emits a warn only once per key', () => {
    const log = createLogger('warn');
    const handler = vi.fn();
    log.addHandler(handler);
    log.warnOnce('k', 'first');
    log.warnOnce('k', 'second');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('warn', ['first']);
  });

  it('warnOnce emits for distinct keys', () => {
    const log = createLogger('warn');
    const handler = vi.fn();
    log.addHandler(handler);
    log.warnOnce('a', 1);
    log.warnOnce('b', 2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('warnOnce respects the level gate (suppressed at "error")', () => {
    const log = createLogger('error');
    const handler = vi.fn();
    log.addHandler(handler);
    log.warnOnce('k', 'x');
    expect(handler).not.toHaveBeenCalled();
  });
});
