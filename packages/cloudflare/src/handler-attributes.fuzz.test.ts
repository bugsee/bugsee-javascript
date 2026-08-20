import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { queueAttributes, scheduledAttributes, tailAttributes } from './handler-attributes';
import { cfAttributes, cloudflareRequestAttributes } from './request-cf';

/**
 * Property-based tests for the two attribute builders that read HOST-SUPPLIED, untyped input.
 *
 * `scheduledAttributes` / `queueAttributes` / `tailAttributes` take whatever workerd hands the handler, and
 * `cfAttributes` reads `request.cf` — a runtime extension whose shape is not in any type we control and which
 * is entirely absent under `wrangler dev`. The source comments make two promises about all of them:
 *
 *   1. they NEVER throw (a malformed trigger arg must degrade to the marker, not fail the invocation), and
 *   2. they stamp a CURATED set of keys with typed values — nothing else, and no PII.
 *
 * Those are "for any input" claims, which example tests can only sample. The generators below deliberately
 * include the shapes a hand-written test never reaches: primitives where an object is expected, prototype-less
 * objects, throwing getters, and values whose `typeof` is right but whose content is not.
 */

// Any JSON-ish scalar, plus the awkward ones a real host can produce.
const anyScalar = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(Number.NaN),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.constantFrom({}, [], () => {}),
  );

// An arbitrary "controller-ish" / "batch-ish" value: a scalar, or an object with arbitrary members.
const anyTriggerArg = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    anyScalar(),
    fc.dictionary(fc.string(), anyScalar()),
    fc.record({ cron: anyScalar(), scheduledTime: anyScalar() }),
    fc.record({ queue: anyScalar(), messages: anyScalar() }),
  );

describe('handler attributes — never throw, always carry their marker', () => {
  const cases: Array<[string, (v: unknown) => Record<string, unknown>, string, string]> = [
    ['scheduled', (v) => scheduledAttributes(v as never), 'timer', 'scheduled'],
    ['queue', (v) => queueAttributes(v as never), 'pubsub', 'queue'],
    ['tail', (v) => tailAttributes(v as never), 'other', 'tail'],
  ];

  for (const [name, build, trigger, marker] of cases) {
    it(`${name}: any host-supplied argument degrades to the marker rather than throwing`, () => {
      fc.assert(
        fc.property(anyTriggerArg(), (arg) => {
          const attributes = build(arg);
          // The invariant that keeps a malformed trigger from failing the customer's invocation.
          expect(attributes['faas.trigger']).toBe(trigger);
          expect(attributes['cloudflare.handler']).toBe(marker);
        }),
      );
    });

    it(`${name}: emits only curated keys, and every stamped value is a string or a finite number`, () => {
      const allowed = new Set([
        'faas.trigger',
        'cloudflare.handler',
        'faas.cron',
        'faas.time',
        'messaging.destination.name',
        'messaging.batch.message_count',
        'cloudflare.tail.event_count',
      ]);
      fc.assert(
        fc.property(anyTriggerArg(), (arg) => {
          for (const [key, value] of Object.entries(build(arg))) {
            expect(allowed.has(key)).toBe(true);
            // No `undefined` may reach the wire as a "present" attribute, and no NaN/Infinity either:
            // the guards exist to keep a non-representable host value out of the report entirely.
            expect(typeof value === 'string' || Number.isFinite(value)).toBe(true);
          }
        }),
      );
    });
  }

  it('scheduled: faas.time is always a valid ISO-8601 instant when present', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.double(), anyScalar()), (scheduledTime) => {
        const attributes = scheduledAttributes({ scheduledTime } as never);
        const time = attributes['faas.time'];
        if (time === undefined) {
          return;
        }
        expect(typeof time).toBe('string');
        // Round-trips: an "Invalid Date" ISO string cannot exist (toISOString throws), and a value that
        // does not survive the round trip would mean we stamped something the backend cannot parse.
        expect(new Date(time as string).toISOString()).toBe(time);
      }),
    );
  });

  it('queue: the batch count, when present, is exactly the array length', () => {
    fc.assert(
      fc.property(fc.array(fc.constant({})), fc.string(), (messages, queue) => {
        expect(queueAttributes({ queue, messages } as never)).toStrictEqual({
          'faas.trigger': 'pubsub',
          'cloudflare.handler': 'queue',
          'messaging.destination.name': queue,
          'messaging.batch.message_count': messages.length,
        });
      }),
    );
  });
});

describe('cfAttributes — the request.cf enrichment is curated and type-guarded', () => {
  // The curated `cf.*` subset. latitude/longitude/postalCode are DELIBERATELY not here (PII, design D9).
  const ALLOWED = new Set([
    'cf.colo',
    'cf.country',
    'cf.city',
    'cf.timezone',
    'cf.as_organization',
    'cf.asn',
    'http.protocol',
    'tls.version',
  ]);

  const cfValue = (): fc.Arbitrary<unknown> => fc.oneof(fc.string(), anyScalar());

  const requestWith = (cf: unknown): Request => {
    const request = new Request('https://x.test/p');
    Object.defineProperty(request, 'cf', { value: cf, configurable: true });
    return request;
  };

  it('never stamps a key outside the curated set, whatever `cf` carries', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), cfValue()),
        fc.record({
          colo: cfValue(),
          country: cfValue(),
          city: cfValue(),
          timezone: cfValue(),
          asOrganization: cfValue(),
          httpProtocol: cfValue(),
          tlsVersion: cfValue(),
          asn: cfValue(),
          // A field the design deliberately excludes: it must never appear in the output. The prefix makes
          // the value distinguishable in the serialized output (a bare '' is a substring of everything).
          latitude: fc.string().map((s) => `LAT-${s}`),
          longitude: fc.string().map((s) => `LON-${s}`),
        }),
        (extra, curated) => {
          const attributes = cfAttributes(requestWith({ ...extra, ...curated }));
          for (const key of Object.keys(attributes)) {
            expect(ALLOWED.has(key)).toBe(true);
          }
          const serialized = JSON.stringify(attributes);
          expect(serialized).not.toContain(curated.latitude);
          expect(serialized).not.toContain(curated.longitude);
        },
      ),
    );
  });

  it('stamps a cf.* string key exactly when the source value is a string', () => {
    fc.assert(
      fc.property(cfValue(), cfValue(), (colo, asn) => {
        const attributes = cfAttributes(requestWith({ colo, asn }));
        expect('cf.colo' in attributes).toBe(typeof colo === 'string');
        if (typeof colo === 'string') {
          expect(attributes['cf.colo']).toBe(colo);
        }
        // asn is the one NUMERIC field — a numeric string must NOT be coerced into it.
        expect('cf.asn' in attributes).toBe(typeof asn === 'number');
      }),
    );
  });

  it('returns an empty object for any non-object `cf`, and never throws', () => {
    fc.assert(
      fc.property(anyScalar(), (cf) => {
        const attributes = cfAttributes(requestWith(cf));
        if (cf === null || typeof cf !== 'object') {
          expect(attributes).toStrictEqual({});
        }
      }),
    );
  });

  it('cloudflareRequestAttributes is the route attrs UNION the cf attrs (cf never drops http.*)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), cfValue()), (cf) => {
        const request = requestWith(cf);
        const combined = cloudflareRequestAttributes(request);
        // The route stamp survives whatever `cf` contains — a `cf` key can never shadow it, because the
        // cf keys are namespaced and the http.* pair comes from the shared builder.
        expect(combined['http.url']).toBe('/p');
        expect(combined['http.method']).toBe('GET');
        for (const [key, value] of Object.entries(cfAttributes(request))) {
          expect(combined[key]).toBe(value);
        }
      }),
    );
  });
});
