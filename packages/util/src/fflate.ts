/**
 * Re-export of the fflate subset the SDK uses: gzip for the replay stream, zip (one-shot and streaming) for bundle
 * assembly. Keeps fflate a single, version-pinned dependency surface so the
 * rest of the SDK imports compression through `@bugsee/util` rather than depending on fflate
 * directly.
 */
export {
  gunzipSync,
  gzipSync,
  strFromU8,
  strToU8,
  unzipSync,
  Zip,
  ZipDeflate,
  zipSync,
} from 'fflate';
