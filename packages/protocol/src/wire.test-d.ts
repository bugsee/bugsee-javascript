// Type-level tests for the wire shapes, checked by `tsc --noEmit`. Valid example instances must
// type-check (a wrong field type / missing required field fails tsc); union exactness is asserted.

import type {
  EnvironmentEnvelope,
  ManifestJson,
  NetworkEvent,
  NetworkStage,
  RequestJson,
  SourceType,
} from './index';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const env: EnvironmentEnvelope = {
  platform: { type: 'web', version: '124', locale: 'en-US' },
  sdk: { version: '0.0.0', type: 'javascript' },
};

const request: RequestJson = {
  type: 'error',
  summary: 'Boom',
  severity: 3, // Severity (1..5)
  source: { type: 'uncaught', origin: 'window.onerror' },
  created_on: '2026-05-26T00:00:00Z',
  environment: env,
};

const manifest: ManifestJson = {
  version: 2,
  time: { start: 1, end: 2 },
  files: [{ filename: 'network.json', type: 'network', attrs: { count: 3 } }],
  attrs: { plan: 'pro' },
};

const networkEvent: NetworkEvent = {
  timestamp: 1,
  id: 'a',
  sequence: 'a',
  mechanism: 'fetch',
  url: 'https://example.com',
  method: 'GET',
  type: 'complete',
  status: 200,
  custom: { headers: { 'Content-Type': 'application/json' }, body: null },
};

// Negative: omitting a required field must NOT type-check (pins required-ness, so a
// required -> optional regression is caught as an unused @ts-expect-error).
// @ts-expect-error `summary` is required on RequestJson
export const invalidRequest: RequestJson = {
  type: 'error',
  severity: 3,
  source: { type: 'uncaught' },
  created_on: '2026-05-26T00:00:00Z',
  environment: env,
};

// Exported so the example instances + assertions are "used" and evaluated by tsc.
export type WireAssertions = [
  typeof env,
  typeof request,
  typeof manifest,
  typeof networkEvent,
  Expect<
    Equal<
      SourceType,
      | 'programmatic'
      | 'uncaught'
      | 'unhandledrejection'
      | 'console-error'
      | 'http-error'
      | 'snapshot'
      | 'manual-dialog'
    >
  >,
  Expect<
    Equal<
      NetworkStage,
      'before' | 'complete' | 'redirect' | 'error' | 'abort' | 'timing' | 'websocket'
    >
  >,
];
