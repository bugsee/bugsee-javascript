// Type-level tests for the umbrella's public surface, checked by `tsc --noEmit` (the typecheck gate).
// A `@ts-expect-error` line turns into an error the moment the thing it guards becomes legal, so each
// negative below pins a wire internal that must NOT be public (the mobile SDKs expose none of them).

import type { Span, Transaction } from '@bugsee/performance';
import type {
  Bugsee,
  BugseeLaunchOptionsWithPerformance,
  LogExceptionOptions,
  UploadOptions,
} from './index';
import type { Bugsee as NodeBugsee } from './index.node';
import type { Bugsee as WorkerdBugsee } from './index.workerd';

declare const client: Bugsee;
declare const nodeClient: NodeBugsee;
declare const workerdClient: WorkerdBugsee;

// `performanceUploadMode` is a typed launch option: both modes accepted, no cast.
export const batched: BugseeLaunchOptionsWithPerformance = { performanceUploadMode: 'batched' };
export const realtime: BugseeLaunchOptionsWithPerformance = { performanceUploadMode: 'realtime' };
// @ts-expect-error only 'batched' | 'realtime' are valid upload modes.
export const badMode: BugseeLaunchOptionsWithPerformance = { performanceUploadMode: 'instant' };

// The three performance calls sit directly on the launched client, on every entry.
export const txn: Transaction = client.startTransaction('Checkout', 'ui.load', { cart: 1 });
export const txnNoAttrs: Transaction = client.startTransaction('Checkout', 'ui.load');
export const span: Span = client.startSpan('db.query', 'select');
export const spanNoDesc: Span = client.startSpan('db.query');
export const active: Span | undefined = client.getActiveSpan();
export const nodeTxn: Transaction = nodeClient.startTransaction('n', 'op');
export const workerdTxn: Transaction = workerdClient.startTransaction('n', 'op');

// The wire internals are not part of the public options...
// @ts-expect-error `trigger` (the wire source type) is not public.
export const badUpload: UploadOptions = { trigger: 'code_dialog' };
// @ts-expect-error `mechanism` (the wire source mechanism) is not public.
export const badLog: LogExceptionOptions = { mechanism: 'uncaught' };
// ...and a public caller cannot slip them through the client either.
// @ts-expect-error a public caller cannot pass `trigger` to `upload`.
void client.upload({ trigger: 'code_dialog' });
// @ts-expect-error a public caller cannot pass `mechanism` to `logException`.
void client.logException(new Error('x'), { mechanism: 'uncaught' });

// The option types a public launch signature is built from must be NAMEABLE from the entry that exposes
// it. Otherwise the declaration bundler leaves the shared chunk's type private (tsup 9 warns) and a
// consumer emitting declarations hits TS2742 ("inferred type cannot be named").
import type { UmbrellaExtensionOptions as BrowserUmbrella } from './index';
import type {
  BugseeServerLaunchOptions as BunServerOptions,
  UmbrellaExtensionOptions as BunUmbrella,
} from './index.bun';
import type {
  BugseeServerLaunchOptions as DenoServerOptions,
  UmbrellaExtensionOptions as DenoUmbrella,
} from './index.deno';
import type {
  BugseeServerLaunchOptions as NodeServerOptions,
  UmbrellaExtensionOptions as NodeUmbrella,
} from './index.node';

export const nameableServerOptions: [NodeServerOptions, BunServerOptions, DenoServerOptions] = [
  {},
  {},
  {},
];
export const nameableUmbrellaOptions: [BrowserUmbrella, NodeUmbrella, BunUmbrella, DenoUmbrella] = [
  {},
  {},
  {},
  {},
];
