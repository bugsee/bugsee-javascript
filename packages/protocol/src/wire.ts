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
  | 'hang'
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
  /**
   * The id of the request/execution context this report fired in (framework adapters; design:
   * framework-adapters.md). Matches the `context_id` stamped on the capture entries recorded within that
   * context, so a viewer can focus the recording on this one request. Omitted when no context was active.
   */
  context_id?: string;
  /**
   * The W3C trace this report fired in (Bugsee OTLP Profile v1 §16 / cross-project-tracing.md T8). `trace_id`
   * is the cross-project JOIN KEY — a frontend report and the backend report it triggered share it, so the
   * collector stitches them into one distributed transaction. Matches the `trace_id`/`span_id` stamped on the
   * capture entries recorded in the context. Omitted when no trace was active.
   */
  trace_id?: string;
  span_id?: string;
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
/**
 * Lifecycle stage of a network interaction (design §8.7). Request/response transports (fetch/xhr/
 * sendBeacon) use `before`→`complete` (+`redirect`/`error`/`abort`/`timing`). Connection/streaming
 * transports (ws/sse/webtransport) use `open`→`message`*→`close` (+`error`); each `message` carries a
 * `direction`. One transport instance emits multiple events sharing `id`/`sequence`.
 */
export type NetworkStage =
  | 'before'
  | 'complete'
  | 'redirect'
  | 'error'
  | 'abort'
  | 'timing'
  | 'open'
  | 'message'
  | 'close';
// 'http' = Node's native node:http/node:https client (used by axios/got/node-fetch/etc., bypasses
// global fetch); request/response semantics, same before→complete(+error) stages as fetch/xhr.
export type NetworkMechanism =
  | 'fetch'
  | 'xhr'
  | 'ws'
  | 'sse'
  | 'sendBeacon'
  | 'webtransport'
  | 'http';
/** Direction of a streamed frame / event / datagram (ws/sse/webtransport): client→server or back. */
export type NetworkDirection = 'in' | 'out';
/**
 * WebSocket event sub-type — Android's `WebSocketEventType`, serialized under the `event` key.
 *
 * The direction of a frame IS the event name in this vocabulary: `send` is outbound, `message` inbound.
 * The viewer reads this rather than {@link NetworkDirection}, so a JS entry without it rendered every
 * outbound frame as incoming (Wave 5.2). Android:
 *   `serializer.putKeyValue("event", webSocketEventType.getValue(), true)`
 *   `enum WebSocketEventType { Create("create"), Open("open"), Send("send"),
 *                              Message("message"), Close("close"), Error("error") }`
 */
export type WebSocketEventType = 'create' | 'open' | 'send' | 'message' | 'close' | 'error';
export type NoBodyReason =
  | 'size_too_large'
  | 'no_content_type'
  | 'unsupported_content_type'
  | 'cant_read_data';

/**
 * Canonical network event (design §8.7) — a single shape spanning fetch, XHR, WebSocket, SSE and
 * WebTransport; the interceptor sets `mechanism` + the fields relevant to that transport. A request /
 * connection emits multiple entries sharing `id`/`sequence`.
 */
export interface NetworkEvent {
  timestamp: number;
  id: string;
  sequence: string;
  mechanism: NetworkMechanism;
  /** Request URL (fetch/xhr/beacon) or connection/session URL (ws/sse/webtransport). */
  url: string;
  /** HTTP method, or the handshake method for connection transports (GET for ws/sse, CONNECT for wt). */
  method: string;
  type: NetworkStage;
  size?: number;
  redirect?: boolean;
  status?: number;
  statusText?: string;
  customError?: string | null;
  /** Inbound vs outbound for a streamed frame / event / datagram (ws/sse/webtransport `message`). */
  direction?: NetworkDirection;
  /** WebSocket sub-type (Android parity, wire key `event`). `send` = outbound frame, `message` = inbound —
   *  this is what the viewer reads to tell the two apart. */
  event?: WebSocketEventType;
  /** Connection/session close code (ws/webtransport). */
  code?: number;
  /** Connection/session close or abort reason (ws/webtransport). */
  reason?: string;
  /** Sub-channel of a connection: the SSE event name, or a WebTransport stream/datagram identifier. */
  channel?: string;
  custom?: {
    headers?: Record<string, string>;
    body?: string | null;
    error?: string | null;
    no_body_reason?: NoBodyReason | null;
    timings?: Record<string, number>;
  };
  override?: boolean;
}
