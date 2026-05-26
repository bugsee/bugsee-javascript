import type { Operation, OperationDispatcher, OperationObserver } from './contracts';
import { createEventEmitter } from './event-emitter';

// Operation bridge (design §16.2): adapters / build-injected code call onOperation(op); APM and
// custom observers subscribe via registerObserver. Built on EventEmitter, so observer dispatch is
// isolated (a throwing observer can't break the adapter or peers) and routes failures to
// onObserverError.

export function createOperationDispatcher(
  onObserverError?: (err: unknown) => void,
): OperationDispatcher {
  const emitter = createEventEmitter<Operation>(onObserverError);
  return {
    registerObserver(observer: OperationObserver): () => void {
      return emitter.subscribe(observer);
    },
    onOperation(operation: Operation): void {
      emitter.emit(operation);
    },
  };
}
