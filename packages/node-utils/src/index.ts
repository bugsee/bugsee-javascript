// @bugsee/node-utils — http/https/fs/ALS helpers shared by @bugsee/node, bun and electron-main
// (design §5). Built test-first per docs/implementation-standards.md.

export {
  appendFileSecure,
  ensureDir,
  listFiles,
  readFileBytes,
  remove,
  writeFileSecure,
} from './fs-storage';
// httpRequest implements core's HttpTransport; the transport contract types live in @bugsee/core.
export { httpRequest, transportFor } from './http-request';
