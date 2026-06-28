import { describe, expect, it } from 'vitest';
import {
  emailAttributes,
  queueAttributes,
  scheduledAttributes,
  tailAttributes,
} from './handler-attributes';

describe('scheduledAttributes', () => {
  it('stamps faas timer + the cron expression + the scheduled epoch-ms', () => {
    expect(scheduledAttributes({ cron: '0 * * * *', scheduledTime: 1_700_000_000_000 })).toEqual({
      'faas.trigger': 'timer',
      'cloudflare.handler': 'scheduled',
      'faas.cron': '0 * * * *',
      'faas.scheduled_time_ms': 1_700_000_000_000,
    });
  });

  it('omits cron/time when the controller is malformed (defensive)', () => {
    expect(scheduledAttributes({} as never)).toEqual({
      'faas.trigger': 'timer',
      'cloudflare.handler': 'scheduled',
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
    expect(queueAttributes({} as never)).toEqual({
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
    expect(tailAttributes(undefined as never)).toEqual({
      'faas.trigger': 'other',
      'cloudflare.handler': 'tail',
    });
  });
});
