import { TraceName } from '@bugsee/protocol';
import type { TraceProducer, TraceSink } from './trace-producer';

// Type tests (checked by `tsc --noEmit`, the package's typecheck): the sink every producer writes through takes a
// registered name only, so a producer implementing `TraceProducer` directly cannot invent one either.

declare const sink: TraceSink;

sink.emit(TraceName.BATTERY, 1);
sink.emit(TraceName.DISPLAYS, [], 0, { hold: true });

// @ts-expect-error -- a plain string is not a registered trace name
sink.emit('new_trace', 1);

// @ts-expect-error -- not even a string that happens to be a registered value, unless it is the enum member
sink.emit('battery', 1);

const direct: TraceProducer = {
  name: 'direct',
  start(s) {
    s.emit(TraceName.FPS, 60);
    // @ts-expect-error -- an unregistered name through a hand-written producer
    s.emit('invented', 1);
  },
  stop() {},
};
void direct;
