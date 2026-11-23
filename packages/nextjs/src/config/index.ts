// `@bugsee/nextjs/config` — the build-time half of the Next.js integration (source-map upload). Node-only: import it
// from `next.config.{js,mjs,ts}`, never from application code.
export type { BugseeNextContext, WithBugseeOptions } from './context';
export type {
  NextConfigFunction,
  NextConfigInput,
  NextConfigObject,
  WithBugseeDeps,
} from './with-bugsee';
export { withBugsee } from './with-bugsee';
