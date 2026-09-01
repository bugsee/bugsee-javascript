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

  it('carries the numeric code — an HTTP STATUS, never a collector code', () => {
    // 12003 is a COLLECTOR code and belongs in `serverCode`; the constructor's second argument is the
    // HTTP status. Using a collector code here as the example implied the two share a namespace, which
    // is the confusion that let a 200-with-error-envelope be read as a transport status.
    expect(new BugseeError('x', 503).code).toBe(503);
    expect(new BugseeError('x', 503).serverCode).toBeUndefined();
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

  it('is non-fatal by default and carries the fatal flag when set (collector KILL_SDK)', () => {
    // `fatal` is the collector's KILL_SDK verdict — code 99099, carried in `serverCode`. Pairing it with
    // a 401 in the status field, as this test used to, restated the exact conflation the wave removed:
    // an HTTP 401 is an infrastructure answer and no longer kills the client, and an INVALID token
    // arrives as 14019, which is `permanent`.
    expect(new BugseeError('x', 1).fatal).toBe(false);
    const killed = new BugseeError('sdk switched off', 0, { fatal: true, serverCode: 99_099 });
    expect(killed.fatal).toBe(true);
    expect(killed.code).toBe(0); // no HTTP status reached a verdict
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
