# @bugsee/rrweb-record 2.2.2

Prebuilt record-only bundle of the Bugsee-hardened rrweb fork. `@bugsee/rrweb` inlines this at build time.

## Provenance

- Source: `bugsee-port-2.2.2` (`36632a33bc59c040d8d1abdc218a24aa3cdeedbd`, branch `bugsee-port-2.2.2` on `bugsee/rrweb`)
  - merge of upstream tag `rrweb@2.2.2` into `bugsee-port-2.2.0-iframe-block`
  - P4 iframe-block kept over the weaker upstream #1964 check
  - media-element guard (from 2.2.1) uses `AUDIO`/`VIDEO` `nodeName` (cross-realm; upstream `instanceof HTMLMediaElement` dropped iframe media)
- Recipe: from `packages/rrweb/` of a `bugsee/rrweb` checkout (`bugsee-port-2.2.2`), run `vite build --config vite.config.entries.js` then `esbuild dist/rrweb-record.js --bundle --minify --format=esm --outfile=<sdk-checkout>/vendor/rrweb-record/record.js`, where `<sdk-checkout>` is this repository's root (then update the sha256 pinned in `packages/rrweb/src/index.test.ts`)
- Size: 198460 B raw / 62529 B gzip (`gzip -9`). Two clean rebuilds were byte-identical.

This directory is a stand-in for a `bugsee-dist-2.2.2` branch of `bugsee/rrweb`, which has not been pushed yet. Once it is, switch `packages/rrweb` back to a git pin.
