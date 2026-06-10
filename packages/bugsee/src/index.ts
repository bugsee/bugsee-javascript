// bugsee
// Umbrella package; the batteries-included entry (Tier 5). It re-exports the platform SDK surface and
// adds launch() = the platform composition root + the on-by-default extensions (@bugsee/performance:
// web-vitals + transactions + http spans) wired in. See docs/design/sdk-design.md §5.
export type { Bugsee } from '@bugsee/browser';
export { type BugseeLaunchOptionsWithPerformance, launch } from './launch';
