// Type-level tests for the package's public barrel, checked by `tsc --noEmit`. They pin that the
// Client's option/payload types are nameable through `./index` (every other factory ships its
// options type; createClient must too — notably so platform tiers can name the `onError` seam).
// Importing each type from the barrel means dropping any re-export breaks the typecheck gate.

import type { Mechanism } from '@bugsee/protocol';
import type {
  Breadcrumb,
  BreadcrumbInput,
  BugseeClient,
  CreateClientOptions,
  InternalLogExceptionOptions,
  InternalUploadOptions,
  LogExceptionOptions,
  UploadOptions,
} from './index';

// createClient's parameter type — home of the onError injection seam.
const options: CreateClientOptions = {
  onError: (_error: unknown) => {},
  appToken: 'tok',
};

// addBreadcrumb's input: timestamp optional; the base Breadcrumb requires it.
const crumbInput: BreadcrumbInput = { message: 'clicked' };
const crumb: Breadcrumb = { message: 'clicked', timestamp: 1 };

// The INTERNAL logException options carry an optional wire mechanism; the public ones do not.
const mechanism: Mechanism = 'programmatic';
const logOpts: InternalLogExceptionOptions = { mechanism, severity: 'high', labels: ['p1'] };
const publicLogOpts: LogExceptionOptions = { severity: 'high', labels: ['p1'] };
const internalUpload: InternalUploadOptions = { trigger: 'code_dialog', summary: 's' };
const publicUpload: UploadOptions = { summary: 's' };
declare const publicClient: BugseeClient;

// --- Negatives ---
// @ts-expect-error onError must accept the thrown value; a wrong-arity handler is rejected.
export const badOptions: CreateClientOptions = { onError: (_a: string, _b: string) => {} };
// @ts-expect-error the base Breadcrumb requires `timestamp` (BreadcrumbInput makes it optional).
export const badCrumb: Breadcrumb = { message: 'x' };

// @ts-expect-error the wire mechanism is not part of the public LogExceptionOptions.
export const badMechanism: LogExceptionOptions = { mechanism };
// @ts-expect-error the wire trigger is not part of the public UploadOptions.
export const badTrigger: UploadOptions = { trigger: 'code_dialog' };
// @ts-expect-error a public caller cannot pass `trigger` to BugseeClient.upload.
void publicClient.upload({ trigger: 'code_dialog' });
// @ts-expect-error a public caller cannot pass `mechanism` to BugseeClient.logException.
void publicClient.logException(new Error('x'), { mechanism });

export type IndexAssertions = [
  typeof options,
  typeof crumbInput,
  typeof crumb,
  typeof logOpts,
  typeof publicLogOpts,
  typeof internalUpload,
  typeof publicUpload,
];
