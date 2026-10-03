import { describe, expect, it } from 'vitest';
import { hasDeviceIdAttribute, stampDeviceIdOnWire } from './device-id-attribute';
import type { TransactionWire } from './span';

const DEVICE = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

const baseWire = (): TransactionWire => ({
  traceId: 't'.repeat(32),
  spanId: 's'.repeat(16),
  name: 'pageload',
  operation: 'pageload',
  status: 'OK',
  sampled: true,
  startTimestampMs: 1,
  endTimestampMs: 2,
  isSnapshot: false,
  spans: [
    {
      spanId: 'c'.repeat(16),
      operation: 'http.client',
      status: 'OK',
      startTimestampMs: 1,
      endTimestampMs: 2,
    },
  ],
});

describe('hasDeviceIdAttribute', () => {
  it('detects device_id, bugsee.device_id, and device.id', () => {
    expect(hasDeviceIdAttribute({ device_id: DEVICE })).toBe(true);
    expect(hasDeviceIdAttribute({ 'bugsee.device_id': DEVICE })).toBe(true);
    expect(hasDeviceIdAttribute({ 'device.id': DEVICE })).toBe(true);
    expect(hasDeviceIdAttribute({ other: 1 })).toBe(false);
    expect(hasDeviceIdAttribute(undefined)).toBe(false);
  });
});

describe('stampDeviceIdOnWire', () => {
  it('stamps device_id on the root and children when absent', () => {
    const out = stampDeviceIdOnWire(baseWire(), DEVICE);
    expect(out.attributes?.device_id).toBe(DEVICE);
    expect(out.spans[0]?.attributes?.device_id).toBe(DEVICE);
  });

  it('does not overwrite an existing device id attribute', () => {
    const child = baseWire().spans[0];
    if (child === undefined) throw new Error('expected child span');
    const wire: TransactionWire = {
      ...baseWire(),
      attributes: { device_id: 'caller-owned' },
      spans: [
        {
          ...child,
          attributes: { 'bugsee.device_id': 'child-owned' },
        },
      ],
    };
    const out = stampDeviceIdOnWire(wire, DEVICE);
    expect(out.attributes?.device_id).toBe('caller-owned');
    expect(out.spans[0]?.attributes?.['bugsee.device_id']).toBe('child-owned');
    expect(out.spans[0]?.attributes?.device_id).toBeUndefined();
  });
});
