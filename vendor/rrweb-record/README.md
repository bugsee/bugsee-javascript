# @bugsee/rrweb-record 2.2.1

Prebuilt record-only bundle of the Bugsee-hardened rrweb fork. `@bugsee/rrweb` inlines this at build time.

## Provenance

- Source: `bugsee-port-2.2.1` (`69633fc17909ab68ff473b2de4ec30316a9c90a8`)
  - merge of upstream tag `rrweb@2.2.1` into `bugsee-port-2.2.0-iframe-block`
  - P4 iframe-block kept over the weaker upstream #1964 check
  - 2.2.1 media-element guard uses `AUDIO`/`VIDEO` `nodeName` (cross-realm; upstream `instanceof HTMLMediaElement` dropped iframe media)
- Dist: same files as intended `bugsee-dist-2.2.1` (`5a46e7db3c97c1e87ded58e1b83c6f5ef43fec34`)
- Recipe: `vite build --config vite.config.entries.js` then `esbuild dist/rrweb-record.js --bundle --minify --format=esm --outfile=<repo>/vendor/rrweb-record/record.js` (then update the sha256 pinned in `packages/rrweb/src/index.test.ts`)
- Size: 198322 B raw / 62407 B gzip (`gzip -9`). Two clean rebuilds were byte-identical.

This directory is a stand-in for `github:bugsee/rrweb#5a46e7db3c97c1e87ded58e1b83c6f5ef43fec34` because the agent that rebuilt it could not push to `bugsee/rrweb`. Once that commit is on the fork, switch `packages/rrweb` back to the git pin.
