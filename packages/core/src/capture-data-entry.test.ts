import { describe, expect, it } from 'vitest';
import { CaptureDataEntryBase, defaultEntryFactory } from './capture-data-entry';

describe('CaptureDataEntryBase', () => {
  it('stores the type, timestamp and data passed to the constructor', () => {
    const e = new CaptureDataEntryBase('network', 123, { url: 'u' });
    expect(e.type).toBe('network');
    expect(e.timestamp).toBe(123);
    expect(e.data).toEqual({ url: 'u' });
  });

  it('defaults timestamp to 0 and data to undefined', () => {
    const e = new CaptureDataEntryBase('log');
    expect(e.timestamp).toBe(0);
    expect(e.data).toBeUndefined();
  });

  it('serializes timestamp and data to JSON', () => {
    const e = new CaptureDataEntryBase('log', 7, { message: 'hi' });
    expect(JSON.parse(e.serialize())).toEqual({ timestamp: 7, data: { message: 'hi' } });
  });

  it('deserializes timestamp and data into the instance', () => {
    const e = new CaptureDataEntryBase('log');
    e.deserialize(JSON.stringify({ timestamp: 42, data: { a: 1 } }));
    expect(e.timestamp).toBe(42);
    expect(e.data).toEqual({ a: 1 });
  });

  it('deserialize overwrites any prior timestamp and data', () => {
    const e = new CaptureDataEntryBase('log', 1, { old: true });
    e.deserialize(JSON.stringify({ timestamp: 99, data: { new: true } }));
    expect(e.timestamp).toBe(99);
    expect(e.data).toEqual({ new: true });
  });

  it('round-trips through serialize → fresh entry deserialize', () => {
    const original = new CaptureDataEntryBase('events.user', 555, { name: 'checkout', total: 9 });
    const restored = new CaptureDataEntryBase('events.user');
    restored.deserialize(original.serialize());
    expect(restored.timestamp).toBe(555);
    expect(restored.data).toEqual({ name: 'checkout', total: 9 });
  });
});

describe('defaultEntryFactory', () => {
  it('creates an empty CaptureDataEntryBase of the requested type', () => {
    const e = defaultEntryFactory('breadcrumbs');
    expect(e).toBeInstanceOf(CaptureDataEntryBase);
    expect(e.type).toBe('breadcrumbs');
    expect(e.timestamp).toBe(0);
    expect(e.data).toBeUndefined();
  });

  it('produces an entry the exporter can deserialize a stored record into', () => {
    const e = defaultEntryFactory('network');
    e.deserialize(JSON.stringify({ timestamp: 3, data: { url: 'x' } }));
    expect(e.type).toBe('network');
    expect(e.timestamp).toBe(3);
    expect(e.data).toEqual({ url: 'x' });
  });
});
