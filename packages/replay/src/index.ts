// @bugsee/replay — session replay (browser). Lazy-loaded via the `replay` launch option (design D2/D8);
// never in the errors-only bundle. Composes a rrweb recorder capture-provider + a ReplayEncoder service.
// See docs/design/replay.md. Built so far: masking config (RP1) + the replay.bin encoder (RP3).
export { encodeReplay } from './encoder';
export {
  CANVAS_SELECTOR,
  MEDIA_SELECTOR,
  type ReplayMaskingOptions,
  type ResolvedReplayMasking,
  resolveReplayMaskingOptions,
} from './masking';
export {
  type CanvasRecordConfig,
  createReplayCaptureProvider,
  type ReplayCaptureProviderOptions,
  type ReplayRecorder,
  type ReplayRecordFn,
} from './recorder';
export {
  type RegisterReplayOptions,
  type ReplayClientLike,
  type ReplayFileEncoders,
  registerReplay,
} from './register';
