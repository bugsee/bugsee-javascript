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

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/protocol
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
