import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeReport, decodeStreamEntry, encodeStreamEntry, isReport } from './protocol';

/**
 * Property-based tests for the renderer→main wire protocol.
 *
 * This is Electron's trust boundary. A renderer runs page content; a compromised or merely buggy one can
 * put anything on the IPC channel, and whatever the main process decodes goes into the capture store and
 * then onto DISK as `${timestamp}\t${serialized}\n`.
 *
 * The decoder's own comment records a proven exploit against exactly that: a STRING `timestamp` carrying
 * newlines injects extra records into the frame file — the demonstrated case smuggled a shell script into
 * the file it escaped to. So the numeric fields are VALIDATED rather than coerced, and these properties
 * hold the line over generated input.
 */

const KNOWN_TYPES = [
  'log',
  'network',
  'events.user',
  'events.system',
  'traces.system',
  'input',
] as const;

/** Characters that would break out of the tab-separated, newline-terminated frame format. */
const FRAME_BREAKERS = ['\n', '\r', '\t', '\r\n', ' ', ' '];

describe('decodeStreamEntry — the renderer trust boundary (fuzz)', () => {
  it('never throws, for any string a renderer can post', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 300 }),
          fc.json({ maxDepth: 3 }),
          fc.constantFrom('', '{', 'null', '[]', '{"k":"entry"}'),
        ),
        (raw) => {
          expect(() => decodeStreamEntry(raw)).not.toThrow();
        },
      ),
      { numRuns: 1000 },
    );
  });

  /**
   * THE injection defence. Every numeric field must come back as a finite NUMBER, never a string — because
   * `timestamp` is written verbatim into the frame, so a string is an injection primitive.
   */
  it('only ever returns finite numbers for the framed fields', () => {
    fc.assert(
      fc.property(
        fc.record({
          k: fc.constant('entry'),
          t: fc.constantFrom(...KNOWN_TYPES),
          s: fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.constant(Number.NaN)),
          ts: fc.oneof(fc.integer(), fc.string(), fc.constant(null)),
          mono: fc.oneof(fc.double(), fc.string(), fc.constant(null)),
          o: fc.oneof(fc.double(), fc.string(), fc.constant(null)),
          p: fc.jsonValue(),
        }),
        (message) => {
          const decoded = decodeStreamEntry(JSON.stringify(message));
          if (decoded === undefined) {
            return;
          }
          for (const [field, value] of Object.entries({
            seq: decoded.seq,
            timestamp: decoded.timestamp,
            mono: decoded.mono,
            timeOrigin: decoded.timeOrigin,
          })) {
            expect(typeof value, `${field} came back as ${typeof value}`).toBe('number');
            expect(Number.isFinite(value), `${field} is not finite`).toBe(true);
          }
          expect(typeof decoded.payload, 'payload is not a string').toBe('string');
        },
      ),
      { numRuns: 800 },
    );
  });

  /**
   * A framed field carrying a frame-breaking character is REFUSED outright, not sanitised — the proven
   * exploit. Generated across every field that reaches the frame and every breaker.
   */
  it('refuses a message whose framed field could break out of the on-disk frame', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('s', 'ts', 'mono', 'o'),
        fc.constantFrom(...FRAME_BREAKERS),
        fc.constantFrom('1234567890', '0', ''),
        (field, breaker, digits) => {
          const message: Record<string, unknown> = {
            k: 'entry',
            t: 'log',
            s: 1,
            ts: 1,
            mono: 1,
            o: 1,
            p: { m: 'x' },
          };
          // e.g. ts: "1700000000000\nINJECTED\t{...}"
          message[field] = `${digits}${breaker}INJECTED\tpayload`;
          expect(
            decodeStreamEntry(JSON.stringify(message)),
            `a ${field} carrying ${JSON.stringify(breaker)} was accepted`,
          ).toBeUndefined();
        },
      ),
      { numRuns: 400 },
    );
  });

  it('rejects an unknown or absent file type', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .string({ maxLength: 20 })
            .filter((t) => !(KNOWN_TYPES as readonly string[]).includes(t)),
          fc.constantFrom<unknown>(undefined, null, 42, {}, ['log'], '../../etc/passwd'),
        ),
        (type) => {
          const raw = JSON.stringify({ k: 'entry', t: type, s: 1, ts: 1, mono: 1, o: 1, p: {} });
          expect(decodeStreamEntry(raw), `type ${String(type)} was accepted`).toBeUndefined();
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rejects anything that is not an `entry` message', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 16 }).filter((k) => k !== 'entry'),
          fc.constantFrom<unknown>(undefined, null, 1, {}),
        ),
        (kind) => {
          const raw = JSON.stringify({ k: kind, t: 'log', s: 1, ts: 1, mono: 1, o: 1, p: {} });
          expect(decodeStreamEntry(raw)).toBeUndefined();
        },
      ),
      { numRuns: 400 },
    );
  });

  // A payload that cannot be re-serialized must be refused rather than reaching `store.add` with a
  // non-string `serialized`, which would throw out of the ipcMain listener and take the channel down
  // (docs/review/electron-wave02-review.md SEV1 #1).
  it('refuses a payload that cannot be re-serialized', () => {
    for (const p of [undefined, () => 'fn', Symbol('s')]) {
      const raw = `{"k":"entry","t":"log","s":1,"ts":1,"mono":1,"o":1,"p":${JSON.stringify(p) ?? 'undefined'}}`;
      expect(() => decodeStreamEntry(raw)).not.toThrow();
    }
  });

  /** The happy path still works: a genuine encode → decode round-trips. */
  it('round-trips what the renderer encoder produces', () => {
    fc.assert(
      fc.property(
        fc.record({
          type: fc.constantFrom(...KNOWN_TYPES),
          seq: fc.integer({ min: 0, max: 1e9 }),
          timestamp: fc.integer({ min: 0, max: 2 ** 45 }),
          mono: fc.double({ min: 0, max: 1e9, noNaN: true }),
          timeOrigin: fc.double({ min: 0, max: 1e12, noNaN: true }),
          payload: fc.json({ maxDepth: 2 }),
          redacted: fc.boolean(),
        }),
        (entry) => {
          const decoded = decodeStreamEntry(encodeStreamEntry(entry as never));
          expect(decoded).toBeDefined();
          expect(decoded?.type).toBe(entry.type);
          expect(decoded?.seq).toBe(entry.seq);
          expect(decoded?.timestamp).toBe(entry.timestamp);
          expect(decoded?.redacted).toBe(entry.redacted);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('decodeReport / isReport (fuzz)', () => {
  it('never throws, and never confuses a report with an entry', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 200 }), fc.json({ maxDepth: 3 })), (raw) => {
        expect(() => isReport(raw)).not.toThrow();
        expect(() => decodeReport(raw)).not.toThrow();
        // A string the receiver routes as a report must actually decode as one, or it would be
        // dispatched to the report path and then dropped — an incident silently lost.
        if (isReport(raw)) {
          expect(
            decodeStreamEntry(raw),
            'a report also decoded as a capture entry',
          ).toBeUndefined();
        }
      }),
      { numRuns: 800 },
    );
  });
});
