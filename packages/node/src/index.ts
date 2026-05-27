// @bugsee/node — Node platform (tier 2, design §5): http(s) transport, node:fs storage, uncaught/
// unhandledRejection detection, console/network capture. Built test-first per
// docs/implementation-standards.md.

export {
  buildNodeEnvironment,
  type NodeEnvironmentInput,
  realSystemProbe,
  type SystemProbe,
} from './environment';
