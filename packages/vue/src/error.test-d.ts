import { describe, expectTypeOf, it } from 'vitest';
import { createApp } from 'vue';
import { installBugseeErrorHandler, type VueAppLike } from './error';

// A real Vue `App` must be accepted by the seam a user calls. It was not: the structural stand-in
// typed the error handler's `instance` as `unknown`, and a property holding a function is checked
// contravariantly, so `App` was unassignable and only this package's own test double ever fit.
describe('installBugseeErrorHandler', () => {
  it('accepts a real Vue App', () => {
    expectTypeOf(createApp({})).toExtend<VueAppLike>();
    expectTypeOf(installBugseeErrorHandler).toBeCallableWith(createApp({}));
  });

  it('still accepts a minimal structural app', () => {
    expectTypeOf(installBugseeErrorHandler).toBeCallableWith({ config: {} });
  });
});
