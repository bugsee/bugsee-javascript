import type { NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createEventHubs, type InputEvent, type LogEvent } from './hubs';

const netEvent: NetworkEvent = {
  timestamp: 1,
  id: 'n1',
  sequence: 'n1-0',
  mechanism: 'fetch',
  url: 'https://example.com',
  method: 'GET',
  type: 'complete',
};
const logEvent: LogEvent = { timestamp: 2, level: 'info', source: 'console', message: 'hi' };
const inputEvent: InputEvent = { timestamp: 3, type: 'click', target: '#btn' };

describe('createEventHubs', () => {
  it('exposes the three core hubs', () => {
    const hubs = createEventHubs();
    expect(typeof hubs.network.subscribe).toBe('function');
    expect(typeof hubs.log.subscribe).toBe('function');
    expect(typeof hubs.input.subscribe).toBe('function');
  });

  it('delivers a NetworkEvent on the network hub', () => {
    const hubs = createEventHubs();
    const seen: NetworkEvent[] = [];
    hubs.network.subscribe((e) => seen.push(e));
    hubs.network.emit(netEvent);
    expect(seen).toEqual([netEvent]);
  });

  it('delivers a LogEvent on the log hub', () => {
    const hubs = createEventHubs();
    const seen: LogEvent[] = [];
    hubs.log.subscribe((e) => seen.push(e));
    hubs.log.emit(logEvent);
    expect(seen).toEqual([logEvent]);
  });

  it('delivers an InputEvent on the input hub', () => {
    const hubs = createEventHubs();
    const seen: InputEvent[] = [];
    hubs.input.subscribe((e) => seen.push(e));
    hubs.input.emit(inputEvent);
    expect(seen).toEqual([inputEvent]);
  });

  it('hubs are independent — emitting on one does not notify the others', () => {
    const hubs = createEventHubs();
    const net = vi.fn();
    const log = vi.fn();
    const input = vi.fn();
    hubs.network.subscribe(net);
    hubs.log.subscribe(log);
    hubs.input.subscribe(input);
    hubs.network.emit(netEvent);
    expect(net).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  });

  it('each hub is a distinct emitter instance', () => {
    const hubs = createEventHubs();
    expect(hubs.network).not.toBe(hubs.log);
    expect(hubs.log).not.toBe(hubs.input);
    expect(hubs.network).not.toBe(hubs.input);
  });

  it('routes a throwing network subscriber to onListenerError', () => {
    const onError = vi.fn();
    const hubs = createEventHubs(onError);
    const boom = new Error('net');
    hubs.network.subscribe(() => {
      throw boom;
    });
    hubs.network.emit(netEvent);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('routes a throwing log subscriber to onListenerError', () => {
    const onError = vi.fn();
    const hubs = createEventHubs(onError);
    const boom = new Error('log');
    hubs.log.subscribe(() => {
      throw boom;
    });
    hubs.log.emit(logEvent);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('routes a throwing input subscriber to onListenerError', () => {
    const onError = vi.fn();
    const hubs = createEventHubs(onError);
    const boom = new Error('input');
    hubs.input.subscribe(() => {
      throw boom;
    });
    hubs.input.emit(inputEvent);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('separate createEventHubs() calls yield independent hub sets', () => {
    const a = createEventHubs();
    const b = createEventHubs();
    const seen: NetworkEvent[] = [];
    a.network.subscribe((e) => seen.push(e));
    b.network.emit(netEvent); // different set; a's subscriber must not fire
    expect(seen).toEqual([]);
  });
});
