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
  ReportAttachmentInput,
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

// logException's options carry an optional wire mechanism.
const mechanism: Mechanism = 'programmatic';
const logOpts: LogExceptionOptions = { mechanism, severity: 'high', labels: ['p1'] };

// Attachments: string or bytes data; mimeType/fileName optional; reachable from UploadOptions.
const attachment: ReportAttachmentInput = { name: 'log', data: new Uint8Array(1) };
const uploadOpts: UploadOptions = {
  attachments: [attachment, { name: 't', data: 'text', mimeType: 'text/plain' }],
};

// --- Negatives ---
// @ts-expect-error data is required.
export const badAttachment: ReportAttachmentInput = { name: 'x' };
// @ts-expect-error onError must accept the thrown value; a wrong-arity handler is rejected.
export const badOptions: CreateClientOptions = { onError: (_a: string, _b: string) => {} };
// @ts-expect-error the base Breadcrumb requires `timestamp` (BreadcrumbInput makes it optional).
export const badCrumb: Breadcrumb = { message: 'x' };

export type IndexAssertions = [
  typeof options,
  typeof crumbInput,
  typeof crumb,
  typeof logOpts,
  typeof uploadOpts,
];
