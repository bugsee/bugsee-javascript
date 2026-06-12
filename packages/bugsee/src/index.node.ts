// bugsee — the NODE entry (selected via the package `exports` "node" condition). Re-exports the Node SDK
// surface + the umbrella launch() (Node composition root + on-by-default extensions). See ./node.
export type { Bugsee } from '@bugsee/node';
export type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
export { type BugseeNodeLaunchOptions, launch } from './node';
