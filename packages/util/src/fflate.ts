/**
 * Re-export of the fflate subset the SDK uses: gzip for the replay stream and zip for bundle
 * assembly (constraint 2 /). Keeps fflate a single, version-pinned dependency surface so the
 * rest of the SDK imports compression through `@bugsee/util` rather than depending on fflate
 * directly.
 */
export { gunzipSync, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
