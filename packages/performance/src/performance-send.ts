import { type BugseeApi, BugseeError, type HttpTransport } from '@bugsee/core';
import type { EnvironmentEnvelope } from '@bugsee/protocol';
import type { TransactionWire } from './span';

// The performance HTTP client: POST /v2/performance/transactions (the endpoint the @bugsee/performance
// extension owns, §0.6). Reuses the core BugseeApi session/Bearer-auth flow (ensureSession memoizes the
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
  };
}
