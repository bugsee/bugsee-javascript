// Canonical wire-shape types (design §8.5–§8.7). Type-only; validated by tsc via wire.test-d.ts.
// The runtime structures that populate these live in @bugsee/core; this is the wire contract.

import type { AttributeValue, IssueType } from '@bugsee/types';
import type { FileType } from './constants';
import type { Severity } from './levels';

/**
 * How a captured issue originated (design §8.5) — the capture "mechanism", analogous to
 * NetworkEvent.mechanism and Sentry's exception mechanism. Distinct from the issue `type`
 * (bug/crash/error) and from a report's trigger.
 */
export type Mechanism =
  | 'programmatic'
  | 'uncaught'
  | 'unhandledrejection'
  | 'console-error'
  | 'http-error'
  | 'snapshot'
  | 'manual-dialog';

/** Runtime tag in environment.platform.type (design §8.6 / §0.5). */
export type PlatformType =
  | 'web'
  | 'node'
  | 'bun'
  | 'deno'
  | 'workers'
  | 'edge-light'
  | 'service-worker'
  | 'web-worker'
  | 'electron-main'
  | 'electron-renderer';

/** environment envelope (design §8.6). Metadata bags carry an index signature for optional fields. */
export interface EnvironmentEnvelope {
  platform: {
    type: PlatformType;
    version: string;
    [key: string]: unknown;
  };
  hardware?: Record<string, unknown>;
  app?: Record<string, unknown>;
  sdk: {
    version: string;
    type: 'javascript';
    build?: string;
    options?: Record<string, unknown>;
  };
  wrapper?: null;
}

/** The /v2/issues body, also embedded verbatim in the bundle (design §8.5). */
export interface RequestJson {
  type: IssueType;
  summary: string;
  description?: string;
  labels?: string[];
  severity: Severity;
  email?: string;
  signatures?: string[];
  source: { mechanism: Mechanism; origin?: string };
  created_on: string; // ISO-8601 with Z
  environment: EnvironmentEnvelope;
}

/** A file inventory entry in manifest.json (design §8.5). `attrs` lives here, not in request.json. */
export interface ManifestFileEntry {
  filename: string;
  type: FileType;
  name?: string;
  attrs?: Record<string, unknown>;
}

/** manifest.json (design §8.5). */
export interface ManifestJson {
  version: number;
  time: { start: number; end: number };
  files: ManifestFileEntry[];
  attrs: Record<string, AttributeValue>;
}

/** Network event stage values (corrected to Android-canonical, design §8.7). */
export type NetworkStage =
  | 'before'
  | 'complete'
  | 'redirect'
  | 'error'
  | 'abort'
  | 'timing'
  | 'websocket';
export type NetworkMechanism = 'fetch' | 'xhr' | 'ws' | 'sse' | 'sendBeacon';
export type WebSocketEvent = 'create' | 'open' | 'send' | 'message' | 'close' | 'error';
export type NoBodyReason =
  | 'size_too_large'
  | 'no_content_type'
  | 'unsupported_content_type'
  | 'cant_read_data';

/** Canonical network event (design §8.7); a request emits multiple entries sharing id/sequence. */
export interface NetworkEvent {
  timestamp: number;
  id: string;
  sequence: string;
  mechanism: NetworkMechanism;
  url: string;
  method: string;
  type: NetworkStage;
  size?: number;
  redirect?: boolean;
  status?: number;
  statusText?: string;
  customError?: string | null;
  event?: WebSocketEvent | null;
  custom?: {
    headers?: Record<string, string>;
    body?: string | null;
    error?: string | null;
    no_body_reason?: NoBodyReason | null;
    timings?: Record<string, number>;
  };
  override?: boolean;
}
