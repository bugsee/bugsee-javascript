// Type-level tests for the package's public barrel, checked by `tsc --noEmit`. They pin that the
// Client's option/payload types are nameable through `./index` (every other factory ships its
// options type; createClient must too — notably so platform tiers can name the `onError` seam).
// Importing each type from the barrel means dropping any re-export breaks the typecheck gate.

import type { Mechanism } from '@bugsee/protocol';
import type {
  Breadcrumb,
  BreadcrumbInput,
  CreateClientOptions,
  LogExceptionOptions,
} from './index';

// createClient's parameter type — home of the onError injection seam.
const options: CreateClientOptions = {
  onError: (_error: unknown) => {},
  appToken: 'tok',
};

// addBreadcrumb's input: timestamp optional; the base Breadcrumb requires it.
const crumbInput: BreadcrumbInput = { message: 'clicked' };
const crumb: Breadcrumb = { message: 'clicked', timestamp: 1 };

// logException's options carry an optional wire mechanism.
const mechanism: Mechanism = 'programmatic';
const logOpts: LogExceptionOptions = { mechanism, severity: 'high', labels: ['p1'] };

// --- Negatives ---
// @ts-expect-error onError must accept the thrown value; a wrong-arity handler is rejected.
export const badOptions: CreateClientOptions = { onError: (_a: string, _b: string) => {} };
// @ts-expect-error the base Breadcrumb requires `timestamp` (BreadcrumbInput makes it optional).
export const badCrumb: Breadcrumb = { message: 'x' };

export type IndexAssertions = [typeof options, typeof crumbInput, typeof crumb, typeof logOpts];
