// @bugsee/node-utils — http/https/fs/ALS helpers shared by @bugsee/node, bun and electron-main
// (design §5). Built test-first per docs/implementation-standards.md.

export {
  type HttpRequestOptions,
  type HttpResponse,
  httpRequest,
  transportFor,
} from './http-request';
