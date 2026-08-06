// WAVE 3b.1 — the entry that installs the way CUSTOMERS do.
//
// Every other entry imports its runtime's platform package directly (`@bugsee/node`, `@bugsee/bun`,
// `@bugsee/deno`). No customer does that: the documented single-install path is `@bugsee/bugsee`, and which
// implementation they get is decided by the umbrella's `exports` conditions on their runtime. Nothing in
// the suite exercised that decision, which is why a runtime resolving to the wrong implementation was
// invisible to every one of the 109 e2e tests.
//
// This file is deliberately identical for node, bun and deno — the ONLY thing that varies is which runtime
// loads it, and therefore which condition the umbrella resolves through. That is the whole subject.
import { launch } from '@bugsee/bugsee';
import { runEntry } from './run-entry';

runEntry(launch as Parameters<typeof runEntry>[0]);
