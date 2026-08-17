// Type-level tests for the token-typed service facade, checked by `tsc --noEmit`. The Client's
// getService/addService resolve/register by a ServiceToken<T>, so the instance type flows from the
// token and a mismatched factory is rejected.

import { defineService, type ServiceToken, serviceToken } from '@bugsee/service';
import { createClient } from './client';

// Local type-assertion helpers (mirrors the other *.test-d.ts files).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const TypedSvc = serviceToken<{ hello: string }>('typedSvc');

const client = createClient();

// getService(token) resolves to the token's type.
type Got = ReturnType<typeof client.getService<{ hello: string }>>;
// Exported so `noUnusedLocals` does not flag it: DECLARING this alias IS the assertion — `Expect` fails
// to instantiate unless `Equal` is true — so there is nothing to "use" it at a value level.
export type _resolvesToTokenType = Expect<Equal<Got, { hello: string }>>;
const member: string = client.getService(TypedSvc).hello;
void member;

// addService requires a Service whose instance matches the token's type.
client.addService(defineService(TypedSvc, () => ({ hello: 'world' })));
// @ts-expect-error — wrong instance shape for the TypedSvc token.
client.addService(defineService(TypedSvc, () => ({ wrong: 1 })));

// The token BRANDS its instance type: a differently-typed token is rejected where a specific token
// type is required. This pins the phantom `__type` — without it, `ServiceToken<number>` and
// `ServiceToken<{ hello: string }>` are the structurally-identical `{ name: string }`, the misuse
// below type-checks, and the @ts-expect-error becomes unused (a compile error → this test fails).
const NumberSvc = serviceToken<number>('numberSvc');
declare function requireHelloToken(token: ServiceToken<{ hello: string }>): void;
requireHelloToken(TypedSvc);
// @ts-expect-error — ServiceToken<number> is not assignable to ServiceToken<{ hello: string }>.
requireHelloToken(NumberSvc);
