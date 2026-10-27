import { createTraceSuppression } from '@bugsee/capture';
import { expect, it } from 'vitest';
import type { BugseeLaunchOptions, TraceSuppression } from './index';

// Compile-time: `@bugsee/browser` exports the type the public `hostOwnedTraces` option accepts (tsc checks this file).
it('exports TraceSuppression, the live form of the hostOwnedTraces option', () => {
  const suppression: TraceSuppression = createTraceSuppression({ host: ['displays'] });
  const options: BugseeLaunchOptions = { hostOwnedTraces: suppression };
  expect(options.hostOwnedTraces).toBe(suppression);
});
