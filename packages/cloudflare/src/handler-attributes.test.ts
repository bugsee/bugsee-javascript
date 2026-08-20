import { describe, expect, it } from 'vitest';
import {
  emailAttributes,
  queueAttributes,
  scheduledAttributes,
  tailAttributes,
} from './handler-attributes';

describe('scheduledAttributes', () => {
  it('stamps faas timer + the cron expression + the canonical faas.time (ISO)', () => {
    expect(scheduledAttributes({ cron: '0 * * * *', scheduledTime: 1_700_000_000_000 })).toEqual({
      'faas.trigger': 'timer',
      'cloudflare.handler': 'scheduled',
      'faas.cron': '0 * * * *',
      'faas.time': '2023-11-14T22:13:20.000Z',
    });
  });

  // toStrictEqual, not toEqual: `toEqual` treats `{a, 'faas.cron': undefined}` as equal to `{a}`, so it
  // cannot tell an OMITTED key from one stamped as `undefined` — which is precisely what these tests claim.
  it('omits cron/time when the controller is malformed (defensive)', () => {
    expect(scheduledAttributes({} as never)).toStrictEqual({
      'faas.trigger': 'timer',
      'cloudflare.handler': 'scheduled',
    });
  });

  it('degrades to the markers when there is NO controller at all (never throws)', () => {
    // The optional chaining is the guard: `controller.cron` on `undefined` would throw out of the wrapper,
    // turning a malformed cron trigger into a failed invocation.
    expect(scheduledAttributes(undefined as never)).toStrictEqual({
      'faas.trigger': 'timer',
      'cloudflare.handler': 'scheduled',
    });
    expect(scheduledAttributes(null as never)).toStrictEqual({
      'faas.trigger': 'timer',
      'cloudflare.handler': 'scheduled',
    });
  });

  it('ignores a non-string cron and a non-number scheduledTime (type guards, not truthiness)', () => {
    // A STRING scheduledTime is the case a truthiness check would wave through: `new Date('2023-…')` is a
    // perfectly valid Date, so only the `typeof === 'number'` guard keeps a non-epoch value out of faas.time.
    expect(
      scheduledAttributes({ cron: 5, scheduledTime: '2023-11-14T22:13:20.000Z' } as never),
    ).toStrictEqual({
      'faas.trigger': 'timer',
      'cloudflare.handler': 'scheduled',
    });
  });

  it('omits faas.time when the scheduledTime is out of range (Invalid Date — never throws)', () => {
    expect(scheduledAttributes({ cron: '* * * * *', scheduledTime: 1e21 })).toEqual({
      'faas.trigger': 'timer',
      'cloudflare.handler': 'scheduled',
      'faas.cron': '* * * * *',
    });
  });
});

describe('queueAttributes', () => {
  it('stamps faas pubsub + the queue name + the batch size', () => {
    expect(queueAttributes({ queue: 'emails', messages: [{}, {}, {}] })).toEqual({
      'faas.trigger': 'pubsub',
      'cloudflare.handler': 'queue',
      'messaging.destination.name': 'emails',
      'messaging.batch.message_count': 3,
    });
  });

  it('omits the queue name / count when the batch is malformed (defensive)', () => {
    expect(queueAttributes({} as never)).toStrictEqual({
      'faas.trigger': 'pubsub',
      'cloudflare.handler': 'queue',
    });
  });

  it('degrades to the markers when there is NO batch at all (never throws)', () => {
    expect(queueAttributes(undefined as never)).toStrictEqual({
      'faas.trigger': 'pubsub',
      'cloudflare.handler': 'queue',
    });
  });

  it('ignores a non-string queue name and non-array messages (type guards)', () => {
    expect(queueAttributes({ queue: 42, messages: 'three' } as never)).toStrictEqual({
      'faas.trigger': 'pubsub',
      'cloudflare.handler': 'queue',
    });
  });
});

describe('emailAttributes', () => {
  it('stamps faas other + the email marker and NO addresses (PII-safe)', () => {
    expect(emailAttributes()).toEqual({ 'faas.trigger': 'other', 'cloudflare.handler': 'email' });
  });
});

describe('tailAttributes', () => {
  it('stamps faas other + the forwarded-event count', () => {
    expect(tailAttributes([{}, {}])).toEqual({
      'faas.trigger': 'other',
      'cloudflare.handler': 'tail',
      'cloudflare.tail.event_count': 2,
    });
  });

  it('omits the count when events is not an array (defensive)', () => {
    expect(tailAttributes(undefined as never)).toStrictEqual({
      'faas.trigger': 'other',
      'cloudflare.handler': 'tail',
    });
  });
});
