// Type-level export parity across the seven umbrella entries (review O5). Each import below fails
// `tsc --noEmit` (the typecheck gate) the moment an entry stops re-exporting the type, which is the only
// way to catch a type-only export (it has no runtime footprint). The runtime names are covered by
// `export-parity.test.ts`.

import type * as Browser from './index';
import type * as Bun from './index.bun';
import type * as Deno from './index.deno';
import type * as EdgeLight from './index.edge-light';
import type * as Node from './index.node';
import type * as Worker from './index.worker';
import type * as Workerd from './index.workerd';

type Entry =
  | typeof Browser
  | typeof Node
  | typeof Bun
  | typeof Deno
  | typeof EdgeLight
  | typeof Worker
  | typeof Workerd;

// The shared type surface, expressed per entry as a tuple of the types that must resolve.
export type BrowserTypes = [
  Browser.DefaultNetworkSanitizer,
  Browser.Span,
  Browser.Transaction,
  Browser.PerformanceFacade,
  Browser.PerformanceApi,
];
export type NodeTypes = [
  Node.DefaultNetworkSanitizer,
  Node.Span,
  Node.Transaction,
  Node.PerformanceFacade,
  Node.PerformanceApi,
];
export type BunTypes = [
  Bun.DefaultNetworkSanitizer,
  Bun.Span,
  Bun.Transaction,
  Bun.PerformanceFacade,
  Bun.PerformanceApi,
];
export type DenoTypes = [
  Deno.DefaultNetworkSanitizer,
  Deno.Span,
  Deno.Transaction,
  Deno.PerformanceFacade,
  Deno.PerformanceApi,
];
export type EdgeLightTypes = [
  EdgeLight.DefaultNetworkSanitizer,
  EdgeLight.Span,
  EdgeLight.Transaction,
  EdgeLight.PerformanceFacade,
  EdgeLight.PerformanceApi,
];
export type WorkerTypes = [
  Worker.DefaultNetworkSanitizer,
  Worker.Span,
  Worker.Transaction,
  Worker.PerformanceFacade,
  Worker.PerformanceApi,
];
export type WorkerdTypes = [
  Workerd.DefaultNetworkSanitizer,
  Workerd.Span,
  Workerd.Transaction,
  Workerd.PerformanceFacade,
  Workerd.PerformanceApi,
];

// Every entry exposes the same getDefaultNetworkSanitizer signature.
export type SanitizerFactories = Entry['getDefaultNetworkSanitizer'];

// R2L-4: every entry's `launch()` accepts the `lifecycleEventsListener` option (the worker, edge and webview
// tiers once did not, so Launching/Launched were unobservable there). `Pick` fails to compile when a key is
// missing from the options type, which is the whole assertion.
type LaunchOptionsOf<E extends { launch: (appToken: string, options?: never) => unknown }> =
  NonNullable<Parameters<E['launch']>[1]>;
type ListenerOption<E extends { launch: (appToken: string, options?: never) => unknown }> = Pick<
  LaunchOptionsOf<E>,
  'lifecycleEventsListener'
>;
export type LifecycleListenerOptions = [
  ListenerOption<typeof Browser>,
  ListenerOption<typeof Node>,
  ListenerOption<typeof Bun>,
  ListenerOption<typeof Deno>,
  ListenerOption<typeof EdgeLight>,
  ListenerOption<typeof Worker>,
  ListenerOption<typeof Workerd>,
];
