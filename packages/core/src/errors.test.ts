import { describe, expect, it } from 'vitest';
import { BugseeError } from './errors';

describe('BugseeError', () => {
  it('is an instance of both Error and BugseeError', () => {
    const err = new BugseeError('boom', 42);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BugseeError);
  });

  it('carries the message', () => {
    expect(new BugseeError('something failed', 1).message).toBe('something failed');
  });

  it('carries the numeric code', () => {
    expect(new BugseeError('x', 12003).code).toBe(12003);
  });

  it('sets name to "BugseeError"', () => {
    expect(new BugseeError('x', 1).name).toBe('BugseeError');
  });

  it('chains the underlying cause when provided', () => {
    const root = new Error('root');
    const err = new BugseeError('wrapped', 1, { cause: root });
    expect(err.cause).toBe(root);
  });

  it('leaves cause undefined when no options are given', () => {
    expect(new BugseeError('x', 1).cause).toBeUndefined();
  });

  it('is non-fatal by default and carries the fatal flag when set (invalid-token kill-state)', () => {
    expect(new BugseeError('x', 1).fatal).toBe(false);
    expect(new BugseeError('bad token', 401, { fatal: true }).fatal).toBe(true);
  });

  it('renders name and message via toString (standard Error formatting)', () => {
    expect(new BugseeError('nope', 7).toString()).toBe('BugseeError: nope');
  });

  it('captures a stack trace', () => {
    expect(typeof new BugseeError('x', 1).stack).toBe('string');
  });

  it('is throwable and catchable as a BugseeError with its code intact', () => {
    try {
      throw new BugseeError('kill', 1001);
    } catch (e) {
      expect(e).toBeInstanceOf(BugseeError);
      expect((e as BugseeError).code).toBe(1001);
    }
  });
});
