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
  reportMessage,
  secureMessage,
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

describe('reportMessage', () => {
  it('builds a versioned report trigger (k:report) carrying the serialized report metadata', () => {
    const m = reportMessage({
      type: 'crash',
      seq: 9,
      timestamp: 2000,
      mono: 3,
      timeOrigin: 1000,
      payload: '{"summary":"boom"}',
      redacted: false,
    });
    expect(m).toEqual({
      b: PROTOCOL_VERSION,
      k: 'report',
      t: 'crash',
      s: 9,
      ts: 2000,
      mono: 3,
      o: 1000,
      red: false,
      p: '{"summary":"boom"}',
    });
    expect('tr' in m).toBe(false);
  });

  it('includes the trace join only when provided', () => {
    const m = reportMessage({
      type: 'crash',
      seq: 1,
      timestamp: 1,
      mono: 1,
      timeOrigin: 0,
      payload: 'p',
      redacted: true,
      trace: { t: 'tr-1', s: 'sp-1' },
    });
    expect(m.tr).toEqual({ t: 'tr-1', s: 'sp-1' });
  });
});

describe('secureMessage', () => {
  it('builds a versioned secure-areas message (k:secure) carrying the serialized rects', () => {
    const m = secureMessage({
      seq: 4,
      timestamp: 500,
      mono: 2,
      timeOrigin: 100,
      payload: '[{"type":"text","top":1,"left":2,"bottom":3,"right":4}]',
    });
    expect(m).toEqual({
      b: PROTOCOL_VERSION,
      k: 'secure',
      s: 4,
      ts: 500,
      mono: 2,
      o: 100,
      p: '[{"type":"text","top":1,"left":2,"bottom":3,"right":4}]',
    });
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
  it('round-trips a payload-less message (hello) identically', () => {
    const m = helloMessage({ sdk: '0', caps: [], session: 's' });
    expect(JSON.parse(encode(m))).toEqual(m);
  });

  it('round-trips a payload-less message (bye) identically', () => {
    const m = byeMessage();
    expect(JSON.parse(encode(m))).toEqual(m);
  });

  it('splices an entry payload INLINE (object on the wire), serialized once — not a quoted string', () => {
    const m = entryMessage({
      type: 'network',
      seq: 1,
      timestamp: 10,
      mono: 2,
      timeOrigin: 100,
      payload: '{"url":"x","n":1}',
      redacted: false,
    });
    const wire = encode(m);
    // Inline: the payload appears as a raw object value, NOT double-encoded as a quoted/escaped string.
    expect(wire).toContain('"p":{"url":"x","n":1}');
    expect(wire).not.toContain('"p":"'); // no quoted-string payload
    expect(wire).not.toContain('\\"'); // no escaped quotes (single-encode)
    // One parse yields the whole message with `p` as the nested object.
    expect(JSON.parse(wire)).toEqual({ ...m, p: { url: 'x', n: 1 } });
  });

  it('splices a report payload INLINE (object on the wire)', () => {
    const m = reportMessage({
      type: 'crash',
      seq: 2,
      timestamp: 20,
      mono: 3,
      timeOrigin: 100,
      payload: '{"report":{"id":"i1"}}',
      redacted: false,
    });
    expect(JSON.parse(encode(m))).toEqual({ ...m, p: { report: { id: 'i1' } } });
  });

  it('splices a secure payload INLINE (array on the wire)', () => {
    const m = secureMessage({
      seq: 3,
      timestamp: 30,
      mono: 4,
      timeOrigin: 100,
      payload: '[{"type":"text","top":1,"left":2,"bottom":3,"right":4}]',
    });
    const decoded = JSON.parse(encode(m));
    expect(decoded.p).toEqual([{ type: 'text', top: 1, left: 2, bottom: 3, right: 4 }]);
    expect(decoded).toEqual({ ...m, p: decoded.p });
  });

  it('splices each element of a batch INLINE', () => {
    const e = entryMessage({
      type: 'log',
      seq: 5,
      timestamp: 1,
      mono: 1,
      timeOrigin: 0,
      payload: '{"a":1}',
      redacted: false,
    });
    expect(JSON.parse(encode(batchMessage([e, e])))).toEqual({
      b: PROTOCOL_VERSION,
      k: 'batch',
      e: [
        { ...e, p: { a: 1 } },
        { ...e, p: { a: 1 } },
      ],
    });
  });

  it('preserves an entry trace ref alongside the inline payload', () => {
    const m = entryMessage({
      type: 'log',
      seq: 6,
      timestamp: 1,
      mono: 1,
      timeOrigin: 0,
      payload: '{"m":"x"}',
      redacted: true,
      trace: { t: 'tr-1', s: 'sp-1' },
    });
    expect(JSON.parse(encode(m))).toEqual({ ...m, p: { m: 'x' } });
  });
});

describe('parseControl', () => {
  it('parses a versioned native→JS control message (accept + session + config + command)', () => {
    const msg: ControlMessage = {
      b: PROTOCOL_VERSION,
      k: 'control',
      accept: 1,
      session: 'native-9',
      config: { enabledTypes: ['log'], reportTrigger: true },
      command: 'flush',
    };
    expect(parseControl(JSON.stringify(msg))).toEqual(msg);
  });

  it('returns undefined for non-JSON, a non-object, a non-control kind, or a missing version tag', () => {
    expect(parseControl('not json {')).toBeUndefined();
    expect(parseControl('42')).toBeUndefined(); // valid JSON, not an object
    expect(parseControl('null')).toBeUndefined();
    expect(parseControl(JSON.stringify({ b: 1, k: 'entry' }))).toBeUndefined(); // wrong kind
    expect(parseControl(JSON.stringify({ k: 'control', session: 'x' }))).toBeUndefined(); // no `b` tag
  });
});
