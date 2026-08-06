// Fixture Worker for the Durable Object RPC e2e (docs/review/cloudflare.md SEV1 #1).
//
// `instrumentRpcMethods` is a documented, advertised opt-in. On real workerd it did not merely fail to
// instrument — it DELETED the user's RPC surface: `stub.increment()` threw "The RPC receiver does not
// implement the method". Cloudflare's RPC dispatch only exposes methods found on the PROTOTYPE, and the
// instrumentation assigned its wrapper as an OWN property of the instance, shadowing the prototype method
// out of existence as far as RPC is concerned.
//
// The fixture instruments ONE of two methods, so the same instance carries a wrapped method and an
// untouched one — an internal control that distinguishes "instrumentation broke RPC" from "RPC is broken".

// Cloudflare only exposes a Durable Object's methods over RPC when the class extends this base — a DO that
// does not is rejected before any method lookup happens. Provided by workerd itself, so it stays external
// to the bundle.
// @ts-expect-error — `cloudflare:workers` is a workerd-provided module with no local types here.
import { DurableObject } from 'cloudflare:workers';
import { instrumentDurableObject } from '@bugsee/cloudflare';

interface Env {
  BUGSEE_ENDPOINT: string;
  COUNTER: {
    idFromName(name: string): unknown;
    get(id: unknown): { increment(by: number): Promise<number>; untouched(): Promise<string> };
  };
}

class CounterObject extends DurableObject {
  #count = 0;

  /** Instrumented over RPC. */
  increment(by: number): number {
    this.#count += by;
    return this.#count;
  }

  /** NOT instrumented — the control. */
  untouched(): string {
    return 'control-ok';
  }
}

export const Counter = instrumentDurableObject(
  (env) => ({
    appToken: 'e2e-do-token',
    endpoint: (env as Env).BUGSEE_ENDPOINT,
    captureNetwork: false,
  }),
  CounterObject as never,
  { instrumentRpcMethods: ['increment'] },
) as never;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.COUNTER.get(env.COUNTER.idFromName('c1'));
    const which = new URL(request.url).pathname;
    try {
      if (which === '/untouched') {
        return new Response(await stub.untouched());
      }
      const a = await stub.increment(2);
      const b = await stub.increment(3);
      return new Response(`${a},${b}`);
    } catch (error) {
      return new Response(`THREW: ${(error as Error).message}`, { status: 500 });
    }
  },
};
