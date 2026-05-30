// Type-level tests for the NameServiceMapping-typed service facade, checked by `tsc --noEmit`.
// The Client's getService/addService key into the declaration-merged NameServiceMapping, so a
// registered service resolves to its mapped instance type and an unknown name is rejected.

import { defineService } from '@bugsee/service';
import { createClient } from './client';

// Local type-assertion helpers (mirrors the other *.test-d.ts files).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare module '@bugsee/types' {
  interface NameServiceMapping {
    typedSvc: { hello: string };
  }
}

const client = createClient();

// getService('typedSvc') resolves to the mapped instance type.
type Got = ReturnType<typeof client.getService<'typedSvc'>>;
type _resolvesToMapped = Expect<Equal<Got, { hello: string }>>;
const member: string = client.getService('typedSvc').hello;
void member;

// @ts-expect-error — an unknown name is not a NameServiceMapping key.
client.getService('not-a-service');

// addService requires a Service whose instance matches the mapped type.
client.addService(defineService('typedSvc', () => ({ hello: 'world' })));
// @ts-expect-error — wrong instance shape for 'typedSvc'.
client.addService(defineService('typedSvc', () => ({ wrong: 1 })));
