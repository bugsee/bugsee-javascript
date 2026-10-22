# @bugsee/protocol

The wire contract of the Bugsee JavaScript SDK: the shapes the SDK uploads and the rules for sanitizing them.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead.

## What it contains

- Wire-shape types for environments, events, traces and reports, and the bundle constants.
- Launch-option key translation and enum maps.
- Sanitizer deny-lists and shape redaction.
- The `./upload-contract.schema.json` JSON schema of the upload bundle.

It is used by `@bugsee/core`, `@bugsee/capture`, `@bugsee/browser`, `@bugsee/node`, `@bugsee/performance`, `@bugsee/electron` and other SDK packages. Its API is internal and may change between releases.

## Sanitizing a page address

`sanitizeUrl` redacts network URLs and is deliberately unchanged for them. `sanitizeLocationUrl(url, options?)` is for the page's own address (the `url` trace, navigation breadcrumbs, navigation transaction names). It adds scheme handling (`data:`/`javascript:`/`vbscript:` reduced to `<scheme>:%3Credacted%3E`, `blob:`/`filesystem:` to their inner origin, `file:` to `file:///.../<last segment>`, `view-source:` sanitizes what it wraps) and a bounded scan of URLs nested in a query value (two levels, raw or percent-encoded), then defers to `sanitizeUrl`. The location denylist adds the exact keys `code`, `state`, `session`, `sid`, `sig`, `ticket` (the shared substring list already catches `sessionid`, `signature`, `otp`, `code_verifier`), the hash-router query is scanned, an address over 8192 characters is clipped and marked `%3Ctruncated%3E`, and a raw `https:/u:p@a.com` or backslash form is read the way a browser would. `sanitizeLocationName(href, pathname)` gives the path-only name used for transaction names. It never throws; a non-string yields the placeholder.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/protocol
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
