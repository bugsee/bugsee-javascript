import { describe, expect, it, vi } from 'vitest';
import type { Operation } from './contracts';
import { createOperationDispatcher } from './operation-dispatcher';

const op = (type: string): Operation => ({ type, timestamp: 1 });

describe('createOperationDispatcher', () => {
  it('delivers an operation to a registered observer', () => {
    const d = createOperationDispatcher();
    const seen: Operation[] = [];
    d.registerObserver((o) => seen.push(o));
    const operation = op('http');
    d.onOperation(operation);
    expect(seen).toEqual([operation]);
  });

  it('fans out to multiple observers', () => {
    const d = createOperationDispatcher();
    const a = vi.fn();
    const b = vi.fn();
    d.registerObserver(a);
    d.registerObserver(b);
    d.onOperation(op('db'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('the returned unsubscribe stops further delivery', () => {
    const d = createOperationDispatcher();
    const seen: Operation[] = [];
    const off = d.registerObserver((o) => seen.push(o));
    d.onOperation(op('a'));
    off();
    d.onOperation(op('b'));
    expect(seen).toEqual([op('a')]);
  });

  it('isolates a throwing observer and routes the error to onObserverError', () => {
    const onError = vi.fn();
    const d = createOperationDispatcher(onError);
    const boom = new Error('boom');
    d.registerObserver(() => {
      throw boom;
    });
    const seen: Operation[] = [];
    d.registerObserver((o) => seen.push(o));
    expect(() => d.onOperation(op('x'))).not.toThrow();
    expect(seen).toEqual([op('x')]);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('onOperation with no observers is a no-op', () => {
    expect(() => createOperationDispatcher().onOperation(op('x'))).not.toThrow();
  });
});
