import type { AttributeValue } from '@bugsee/vercel-edge';
import type { MessageBatch, ScheduledController, TraceItem } from './cloudflare-types';

// Per-handler-type context attributes for the non-fetch Cloudflare triggers (docs/design/edge-runtime.md C2).
// Keys follow OTel FaaS conventions (`faas.trigger`, `faas.cron`, `messaging.*`) plus a `cloudflare.handler`
// marker so an incident report names WHICH trigger fired (`faas.trigger` alone can't tell email from tail).
// PII-safe: no email addresses, no message bodies/payloads. Defensive — a malformed trigger arg degrades to the
// marker rather than throwing (these run on real Cloudflare objects, but never trust the shape blindly).

/** Cron (`scheduled`) → `faas.trigger: timer` + the cron expression + the canonical `faas.time` (the scheduled
 *  invocation time, ISO-8601 — OTel FaaS). A non-representable scheduledTime is dropped, never thrown. */
export function scheduledAttributes(
  controller: ScheduledController,
): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {
    'faas.trigger': 'timer',
    'cloudflare.handler': 'scheduled',
  };
  if (typeof controller?.cron === 'string') {
    attributes['faas.cron'] = controller.cron;
  }
  if (typeof controller?.scheduledTime === 'number') {
    const time = new Date(controller.scheduledTime);
    if (!Number.isNaN(time.getTime())) {
      attributes['faas.time'] = time.toISOString(); // guard: an out-of-range epoch-ms → Invalid Date, omit
    }
  }
  return attributes;
}

/** Queue (`queue`) → `faas.trigger: pubsub` + the queue name + the batch size. */
export function queueAttributes(batch: MessageBatch): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {
    'faas.trigger': 'pubsub',
    'cloudflare.handler': 'queue',
  };
  if (typeof batch?.queue === 'string') {
    attributes['messaging.destination.name'] = batch.queue;
  }
  if (Array.isArray(batch?.messages)) {
    attributes['messaging.batch.message_count'] = batch.messages.length;
  }
  return attributes;
}

/** Email (`email`) → `faas.trigger: other`. The from/to addresses are deliberately NOT stamped (PII). */
export function emailAttributes(): Record<string, AttributeValue> {
  return { 'faas.trigger': 'other', 'cloudflare.handler': 'email' };
}

/** Tail (`tail`) → `faas.trigger: other` + the forwarded-event count. */
export function tailAttributes(events: ReadonlyArray<TraceItem>): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {
    'faas.trigger': 'other',
    'cloudflare.handler': 'tail',
  };
  if (Array.isArray(events)) {
    attributes['cloudflare.tail.event_count'] = events.length;
  }
  return attributes;
}
