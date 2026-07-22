// @bugsee/replay-canvas — opt-in canvas-replay add-on for @bugsee/replay (see docs/design/replay-canvas.md).
// rrweb 2.1.0 records <canvas> content by options alone, so this is a small PURE options-builder that
// resolves friendly canvas options into the `CanvasRecordConfig` seam @bugsee/replay spreads into rrweb
// `record()`. Lazy-imported by @bugsee/browser only when the `replay: { canvas }` option is set.
export { type CanvasReplayOptions, createCanvasRecordConfig } from './canvas-config';
