import { type BugseeApi, BugseeError, type HttpTransport } from '@bugsee/core';
import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { strFromU8 } from '@bugsee/util';
import type { TransactionWire } from './span';

// The performance HTTP client: POST /v2/performance/transactions (the endpoint the @bugsee/performance
// extension owns). Reuses the core BugseeApi session/Bearer-auth flow (ensureSession memoizes the
// access token) so it shares the same authenticated session as the bundle upload. This is the `send`
// injected into the uploader; the umbrella wires it from the launched client's api/transport.

export interface PerformanceSendDeps {
  api: BugseeApi;
  transport: HttpTransport;
  /** API origin, no trailing slash. */
  baseUrl: string;
  getEnvironment: () => EnvironmentEnvelope;
}

export function createPerformanceSend(
  deps: PerformanceSendDeps,
): (transactions: TransactionWire[]) => Promise<void> {
  return async (transactions) => {
    const token = await deps.api.ensureSession(deps.getEnvironment());
    const response = await deps.transport(`${deps.baseUrl}/v2/performance/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ transactions }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new BugseeError(`performance upload failed (${response.status})`, response.status);
    }
    rejectionOf(response.body);
  };
}

/**
 * The collector's `/v2/*` rejections arrive with HTTP 200 and the verdict in the envelope
 * (`{ ok: false, error }`), so a 2xx alone does not mean the batch was accepted. An unreadable, empty or
 * `ok`-less body is passed through as success (a proxied or v1-shaped response still works).
 */
function rejectionOf(body: Uint8Array): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(strFromU8(body));
  } catch {
    return;
  }
  const envelope = decoded as {
    ok?: unknown;
    error?: { type?: string; message?: string; code?: number };
  };
  if (typeof envelope !== 'object' || envelope === null || envelope.ok !== false) {
    return;
  }
  const { type = 'CollectorError', message = 'rejected', code = 0 } = envelope.error ?? {};
  throw new BugseeError(`performance upload rejected: ${type}: ${message}`, 0, {
    serverCode: code,
  });
}
