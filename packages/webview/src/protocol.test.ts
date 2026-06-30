import { describe, expect, it } from 'vitest';
import {
  batchMessage,
  byeMessage,
  type ControlMessage,
  type EntryMessage,
  encode,
  entryMessage,
  helloMessage,
  PROTOCOL_VERSION,
  parseControl,
} from './protocol';

describe('helloMessage', () => {
  it('builds a versioned hello carrying sdk + caps + session', () => {
    const m = helloMessage({
      sdk: '1.2.3',
      caps: ['log', 'network', 'obscuring'],
      session: 'js-1',
    });
    expect(m).toEqual({
      b: PROTOCOL_VERSION,
      k: 'hello',
      sdk: '1.2.3',
      caps: ['log', 'network', 'obscuring'],
      session: 'js-1',
    });
  });
});

describe('entryMessage', () => {
  it('builds a versioned entry with type/seq/time/redaction and the serialized payload', () => {
    const m = entryMessage({
      type: 'network',
      seq: 7,
      timestamp: 1000,
      mono: 12.5,
      timeOrigin: 900,
      payload: '{"url":"x"}',
      redacted: false,
    });
    expect(m).toEqual({
      b: PROTOCOL_VERSION,
      k: 'entry',
      t: 'network',
      s: 7,
      ts: 1000,
      mono: 12.5,
      o: 900,
      red: false,
      p: '{"url":"x"}',
    });
    expect('tr' in m).toBe(false); // no trace ⇒ omitted
  });

  it('includes the trace join only when provided', () => {
    const m = entryMessage({
      type: 'log',
      seq: 1,
      timestamp: 1,
      mono: 1,
      timeOrigin: 0,
      payload: 'p',
      redacted: true,
      trace: { t: 'trace-1', s: 'span-1' },
    });
    expect(m.tr).toEqual({ t: 'trace-1', s: 'span-1' });
    expect(m.red).toBe(true);
  });
});

describe('batchMessage', () => {
  it('coalesces entries into a single versioned batch', () => {
    const e: EntryMessage = entryMessage({
      type: 'log',
      seq: 1,
      timestamp: 1,
      mono: 1,
      timeOrigin: 0,
      payload: 'a',
      redacted: false,
    });
    expect(batchMessage([e, e])).toEqual({ b: PROTOCOL_VERSION, k: 'batch', e: [e, e] });
  });
});

describe('byeMessage', () => {
  it('builds a versioned bye', () => {
    expect(byeMessage()).toEqual({ b: PROTOCOL_VERSION, k: 'bye' });
  });
});

describe('encode', () => {
  it('serializes a message to a JSON string round-trippable back to the message', () => {
    const m = helloMessage({ sdk: '0', caps: [], session: 's' });
    expect(JSON.parse(encode(m))).toEqual(m);
  });
});

describe('parseControl', () => {
  it('parses a native→JS control message (accept + session + config + command)', () => {
    const raw = JSON.stringify({
      k: 'control',
      accept: 1,
      session: 'native-9',
      config: { enabledTypes: ['log'], reportTrigger: true },
      command: 'flush',
    } satisfies ControlMessage);
    expect(parseControl(raw)).toEqual({
      k: 'control',
      accept: 1,
      session: 'native-9',
      config: { enabledTypes: ['log'], reportTrigger: true },
      command: 'flush',
    });
  });

  it('returns undefined for non-JSON, a non-object, or a non-control kind', () => {
    expect(parseControl('not json {')).toBeUndefined();
    expect(parseControl('42')).toBeUndefined(); // valid JSON, not an object
    expect(parseControl('null')).toBeUndefined();
    expect(parseControl(JSON.stringify({ k: 'entry' }))).toBeUndefined(); // wrong kind
  });
});
