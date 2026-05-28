// Type-level tests for the wire shapes, checked by `tsc --noEmit`. Minimal instances pin the
// required fields; fully-populated instances exercise every optional field with its correct type;
// `@ts-expect-error` negatives pin required-ness (a required -> optional regression surfaces as an
// unused directive and fails tsc); `Equal<>` assertions pin each union's exact membership.

import type {
  EnvironmentEnvelope,
  ManifestFileEntry,
  ManifestJson,
  Mechanism,
  NetworkDirection,
  NetworkEvent,
  NetworkMechanism,
  NetworkStage,
  NoBodyReason,
  PlatformType,
  RequestJson,
} from './index';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- Minimal instances: only required fields present. ---
const env: EnvironmentEnvelope = {
  platform: { type: 'web', version: '124', locale: 'en-US' }, // locale exercises the index signature
  sdk: { version: '0.0.0', type: 'javascript' },
};

const request: RequestJson = {
  type: 'error',
  summary: 'Boom',
  severity: 3,
  source: { mechanism: 'uncaught' },
  created_on: '2026-05-26T00:00:00Z',
  environment: env,
};

const manifest: ManifestJson = {
  version: 2,
  time: { start: 1, end: 2 },
  files: [{ filename: 'network.json', type: 'network' }],
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
};

// --- Fully-populated instances: every optional field present and correctly typed. ---
const fullEnv: EnvironmentEnvelope = {
  platform: { type: 'node', version: '22', arch: 'arm64' },
  hardware: { cores: 8 },
  app: { name: 'demo' },
  sdk: { version: '1.0.0', type: 'javascript', build: 'abc123', options: { autoStart: true } },
  wrapper: null,
};

const fullRequest: RequestJson = {
  type: 'error',
  summary: 'Boom',
  description: 'detail',
  labels: ['a', 'b'],
  severity: 5,
  email: 'x@example.com',
  signatures: ['sig'],
  source: { mechanism: 'http-error', origin: 'fetch' },
  created_on: '2026-05-26T00:00:00Z',
  environment: fullEnv,
};

const fullFileEntry: ManifestFileEntry = {
  filename: 'logs.json',
  type: 'log',
  name: 'app logs',
  attrs: { count: 3 },
};

const fullNetworkEvent: NetworkEvent = {
  timestamp: 1,
  id: 'a',
  sequence: 'a-0',
  mechanism: 'ws',
  url: 'wss://example.com',
  method: 'GET',
  type: 'message',
  size: 10,
  redirect: false,
  status: 101,
  statusText: 'Switching Protocols',
  customError: null,
  direction: 'in',
  code: 1000,
  reason: 'normal closure',
  channel: 'updates',
  custom: {
    headers: { 'Content-Type': 'application/json' },
    body: null,
    error: null,
    no_body_reason: 'size_too_large',
    timings: { dns: 1 },
  },
  override: true,
};

// --- Negatives: omitting ANY required top-level field must NOT type-check. One per required field
// of every interface (the missing-property error on a top-level field is reported at the object
// literal, so a required -> optional regression turns the directive into an unused error). ---

// RequestJson: type, summary, severity, source, created_on, environment.
// @ts-expect-error `type` is required on RequestJson
export const reqNoType: RequestJson = {
  summary: 's',
  severity: 3,
  source: { mechanism: 'uncaught' },
  created_on: 'x',
  environment: env,
};
// @ts-expect-error `summary` is required on RequestJson
export const reqNoSummary: RequestJson = {
  type: 'error',
  severity: 3,
  source: { mechanism: 'uncaught' },
  created_on: 'x',
  environment: env,
};
// @ts-expect-error `severity` is required on RequestJson
export const reqNoSeverity: RequestJson = {
  type: 'error',
  summary: 's',
  source: { mechanism: 'uncaught' },
  created_on: 'x',
  environment: env,
};
// @ts-expect-error `source` is required on RequestJson
export const reqNoSource: RequestJson = {
  type: 'error',
  summary: 's',
  severity: 3,
  created_on: 'x',
  environment: env,
};
// @ts-expect-error `created_on` is required on RequestJson
export const reqNoCreatedOn: RequestJson = {
  type: 'error',
  summary: 's',
  severity: 3,
  source: { mechanism: 'uncaught' },
  environment: env,
};
// @ts-expect-error `environment` is required on RequestJson
export const reqNoEnvironment: RequestJson = {
  type: 'error',
  summary: 's',
  severity: 3,
  source: { mechanism: 'uncaught' },
  created_on: 'x',
};

// Nested: RequestJson.source requires `mechanism` (single-line so the directive pins it directly).
// @ts-expect-error `mechanism` is required on RequestJson.source
export const reqNoMechanism: RequestJson['source'] = { origin: 'x' };

// ManifestJson: version, time, files, attrs.
// @ts-expect-error `version` is required on ManifestJson
export const manNoVersion: ManifestJson = { time: { start: 1, end: 2 }, files: [], attrs: {} };
// @ts-expect-error `time` is required on ManifestJson
export const manNoTime: ManifestJson = { version: 2, files: [], attrs: {} };
// @ts-expect-error `files` is required on ManifestJson
export const manNoFiles: ManifestJson = { version: 2, time: { start: 1, end: 2 }, attrs: {} };
// @ts-expect-error `attrs` is required on ManifestJson
export const manNoAttrs: ManifestJson = { version: 2, time: { start: 1, end: 2 }, files: [] };

// ManifestFileEntry: filename, type.
// @ts-expect-error `filename` is required on ManifestFileEntry
export const feNoFilename: ManifestFileEntry = { type: 'log' };
// @ts-expect-error `type` is required on ManifestFileEntry
export const feNoType: ManifestFileEntry = { filename: 'x' };

// EnvironmentEnvelope: platform, sdk.
// @ts-expect-error `platform` is required on EnvironmentEnvelope
export const envNoPlatform: EnvironmentEnvelope = { sdk: { version: '0', type: 'javascript' } };
// @ts-expect-error `sdk` is required on EnvironmentEnvelope
export const envNoSdk: EnvironmentEnvelope = { platform: { type: 'web', version: '1' } };

// NetworkEvent: timestamp, id, sequence, mechanism, url, method, type.
// @ts-expect-error `timestamp` is required on NetworkEvent
export const neNoTimestamp: NetworkEvent = {
  id: 'a',
  sequence: 'a',
  mechanism: 'fetch',
  url: 'u',
  method: 'GET',
  type: 'complete',
};
// @ts-expect-error `id` is required on NetworkEvent
export const neNoId: NetworkEvent = {
  timestamp: 1,
  sequence: 'a',
  mechanism: 'fetch',
  url: 'u',
  method: 'GET',
  type: 'complete',
};
// @ts-expect-error `sequence` is required on NetworkEvent
export const neNoSequence: NetworkEvent = {
  timestamp: 1,
  id: 'a',
  mechanism: 'fetch',
  url: 'u',
  method: 'GET',
  type: 'complete',
};
// @ts-expect-error `mechanism` is required on NetworkEvent
export const neNoMechanism: NetworkEvent = {
  timestamp: 1,
  id: 'a',
  sequence: 'a',
  url: 'u',
  method: 'GET',
  type: 'complete',
};
// @ts-expect-error `url` is required on NetworkEvent
export const neNoUrl: NetworkEvent = {
  timestamp: 1,
  id: 'a',
  sequence: 'a',
  mechanism: 'fetch',
  method: 'GET',
  type: 'complete',
};
// @ts-expect-error `method` is required on NetworkEvent
export const neNoMethod: NetworkEvent = {
  timestamp: 1,
  id: 'a',
  sequence: 'a',
  mechanism: 'fetch',
  url: 'u',
  type: 'complete',
};
// @ts-expect-error `type` is required on NetworkEvent
export const neNoType: NetworkEvent = {
  timestamp: 1,
  id: 'a',
  sequence: 'a',
  mechanism: 'fetch',
  url: 'u',
  method: 'GET',
};

// Exported so the example instances + assertions are "used" and evaluated by tsc.
export type WireAssertions = [
  typeof env,
  typeof request,
  typeof manifest,
  typeof networkEvent,
  typeof fullEnv,
  typeof fullRequest,
  typeof fullFileEntry,
  typeof fullNetworkEvent,
  Expect<
    Equal<
      Mechanism,
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
      | 'before'
      | 'complete'
      | 'redirect'
      | 'error'
      | 'abort'
      | 'timing'
      | 'open'
      | 'message'
      | 'close'
    >
  >,
  Expect<
    Equal<
      PlatformType,
      | 'web'
      | 'node'
      | 'bun'
      | 'deno'
      | 'workers'
      | 'edge-light'
      | 'service-worker'
      | 'web-worker'
      | 'electron-main'
      | 'electron-renderer'
    >
  >,
  Expect<Equal<NetworkMechanism, 'fetch' | 'xhr' | 'ws' | 'sse' | 'sendBeacon' | 'webtransport'>>,
  Expect<Equal<NetworkDirection, 'in' | 'out'>>,
  Expect<
    Equal<
      NoBodyReason,
      'size_too_large' | 'no_content_type' | 'unsupported_content_type' | 'cant_read_data'
    >
  >,
];
