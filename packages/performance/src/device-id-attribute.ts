import type { SpanWire, TransactionWire } from './span';

const DEVICE_ID_KEY = 'device_id';

/** True when the wire already carries a device id under any ingest-recognized key. */
export function hasDeviceIdAttribute(attributes: Record<string, unknown> | undefined): boolean {
  if (attributes === undefined) return false;
  return (
    attributes[DEVICE_ID_KEY] !== undefined ||
    attributes['bugsee.device_id'] !== undefined ||
    attributes['device.id'] !== undefined
  );
}

function stampSpanAttributes(
  attributes: Record<string, unknown> | undefined,
  deviceId: string,
): Record<string, unknown> {
  if (hasDeviceIdAttribute(attributes)) return attributes ?? {};
  return { ...attributes, [DEVICE_ID_KEY]: deviceId };
}

/** Stamp `device_id` on the transaction root and every child span when absent. */
export function stampDeviceIdOnWire(wire: TransactionWire, deviceId: string): TransactionWire {
  const rootAttributes = stampSpanAttributes(wire.attributes, deviceId);
  const spans = wire.spans.map((span) => {
    const attributes = stampSpanAttributes(span.attributes, deviceId);
    if (attributes === span.attributes) return span;
    return { ...span, attributes };
  });
  const rootChanged = rootAttributes !== wire.attributes;
  const spansChanged = spans.some((span, i) => span !== wire.spans[i]);
  if (!rootChanged && !spansChanged) return wire;
  return {
    ...wire,
    ...(rootChanged ? { attributes: rootAttributes } : {}),
    ...(spansChanged ? { spans } : {}),
  };
}

/** Stamp `device_id` on a single child span wire when absent. */
export function stampDeviceIdOnSpanWire(span: SpanWire, deviceId: string): SpanWire {
  const attributes = stampSpanAttributes(span.attributes, deviceId);
  if (attributes === span.attributes) return span;
  return { ...span, attributes };
}
