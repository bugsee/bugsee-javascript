import { createBlackoutState, createDiskPressure } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { CaptureStateProducer } from './capture-state-producer';
import type { TraceSink } from './trace-producer';

const MB = 1_000_000;

function harness() {
  const emitted: Array<{ name: string; value: unknown; hold: boolean | undefined }> = [];
  const sink: TraceSink = {
    emit: (name, value, _display, options) => emitted.push({ name, value, hold: options?.hold }),
  };
  const states = (): unknown[] => emitted.map((e) => (e.value as { state: string }).state);
  return { emitted, sink, states };
}

describe('CaptureStateProducer', () => {
  it('writes nothing before the host says visual capture runs (no active for a recorder that is not there)', () => {
    const { sink, emitted } = harness();
    const p = new CaptureStateProducer();
    p.bindBlackout(createBlackoutState());
    p.start(sink);
    expect(emitted).toEqual([]);
  });

  it('writes {state:"active"} as a HELD trace once visual capture runs', () => {
    const { sink, emitted } = harness();
    const p = new CaptureStateProducer();
    p.bindBlackout(createBlackoutState());
    p.start(sink);
    p.setVisualCapture(true);
    expect(emitted).toEqual([{ name: 'capture', value: { state: 'active' }, hold: true }]);
  });

  it('follows the blackout state both ways, once per transition', () => {
    const { sink, states } = harness();
    const blackout = createBlackoutState();
    const p = new CaptureStateProducer();
    p.bindBlackout(blackout);
    p.start(sink);
    p.setVisualCapture(true);
    blackout.start();
    blackout.start();
    blackout.end();
    expect(states()).toEqual(['active', 'blackout', 'active']);
  });

  it('starts in blackout when one is already in force', () => {
    const { sink, states } = harness();
    const p = new CaptureStateProducer();
    p.bindBlackout(createBlackoutState(undefined, true));
    p.setVisualCapture(true);
    p.start(sink);
    expect(states()).toEqual(['blackout']);
  });

  it('writes the disk states, and they outrank blackout', () => {
    const { sink, states } = harness();
    const blackout = createBlackoutState();
    const pressure = createDiskPressure();
    const p = new CaptureStateProducer();
    p.bindBlackout(blackout);
    p.bindPressure(pressure);
    p.start(sink);
    p.setVisualCapture(true);
    blackout.start();
    pressure.observe(30 * MB);
    pressure.observe(5 * MB);
    blackout.end(); // still no_disk_space: nothing new is written
    pressure.observe(30 * MB);
    pressure.observe(100 * MB);
    expect(states()).toEqual([
      'active',
      'blackout',
      'low_disk_space',
      'no_disk_space',
      'low_disk_space',
      'active',
    ]);
  });

  it('writes a disk state even before the recorder reports running (the state is true regardless)', () => {
    const { sink, states } = harness();
    const pressure = createDiskPressure();
    const p = new CaptureStateProducer();
    p.bindPressure(pressure);
    p.start(sink);
    pressure.observe(30 * MB);
    expect(states()).toEqual(['low_disk_space']);
  });

  it('binding after start subscribes and evaluates at once', () => {
    const { sink, states } = harness();
    const p = new CaptureStateProducer();
    p.start(sink);
    p.setVisualCapture(true);
    expect(states()).toEqual(['active']);
    const blackout = createBlackoutState(undefined, true);
    p.bindBlackout(blackout);
    expect(states()).toEqual(['active', 'blackout']);
    const pressure = createDiskPressure();
    pressure.observe(5 * MB);
    p.bindPressure(pressure);
    expect(states()).toEqual(['active', 'blackout', 'no_disk_space']);
    blackout.end(); // hidden by disk: nothing
    pressure.observe(100 * MB);
    expect(states()).toEqual(['active', 'blackout', 'no_disk_space', 'active']);
  });

  it('rebinding replaces the earlier gate: the old one no longer drives it', () => {
    const { sink, states } = harness();
    const first = createBlackoutState();
    const second = createBlackoutState();
    const p = new CaptureStateProducer();
    p.bindBlackout(first);
    p.start(sink);
    p.setVisualCapture(true);
    p.bindBlackout(second);
    first.start();
    expect(states()).toEqual(['active']);
    second.start();
    expect(states()).toEqual(['active', 'blackout']);
    const pa = createDiskPressure();
    const pb = createDiskPressure();
    p.bindPressure(pa);
    p.bindPressure(pb);
    pa.observe(30 * MB);
    expect(states()).toEqual(['active', 'blackout']);
    pb.observe(30 * MB);
    expect(states()).toEqual(['active', 'blackout', 'low_disk_space']);
  });

  it('stops listening on stop() and writes nothing afterwards', () => {
    const { sink, states } = harness();
    const blackout = createBlackoutState();
    const pressure = createDiskPressure();
    const p = new CaptureStateProducer();
    p.bindBlackout(blackout);
    p.bindPressure(pressure);
    p.start(sink);
    p.setVisualCapture(true);
    p.stop();
    blackout.start();
    pressure.observe(5 * MB);
    p.setVisualCapture(false);
    p.setVisualCapture(true);
    expect(states()).toEqual(['active']);
    p.bindBlackout(createBlackoutState(undefined, true)); // binding while stopped does not write either
    expect(states()).toEqual(['active']);
  });

  it('stops claiming active/blackout when the recorder reports it is not running (no retraction, no new claim)', () => {
    const { sink, states } = harness();
    const blackout = createBlackoutState();
    const p = new CaptureStateProducer();
    p.bindBlackout(blackout);
    p.start(sink);
    p.setVisualCapture(true);
    p.setVisualCapture(false);
    blackout.start();
    expect(states()).toEqual(['active']);
  });

  it('ends a disk state with active on recovery even without a recorder (a held trace cannot be retracted)', () => {
    const { sink, states } = harness();
    const pressure = createDiskPressure();
    const p = new CaptureStateProducer();
    p.bindPressure(pressure);
    p.start(sink);
    pressure.observe(30 * MB);
    pressure.observe(100 * MB);
    expect(states()).toEqual(['low_disk_space', 'active']);
    pressure.observe(30 * MB);
    pressure.observe(100 * MB);
    expect(states()).toEqual(['low_disk_space', 'active', 'low_disk_space', 'active']);
  });

  it('writes again after a restart', () => {
    const { sink, states } = harness();
    const p = new CaptureStateProducer();
    p.start(sink);
    p.setVisualCapture(true);
    p.stop();
    p.start(sink);
    expect(states()).toEqual(['active', 'active']);
  });
});
