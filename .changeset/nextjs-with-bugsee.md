---
'@bugsee/nextjs': minor
'@bugsee/bundler-plugin-core': minor
---

`@bugsee/nextjs/config` adds `withBugsee(nextConfig, options)`: `next build` now stamps debug-IDs and uploads source maps on both webpack and Turbopack (Next 15.4.0+ for Turbopack, through `compiler.runAfterProductionCompile`). Browser maps are deleted after a confirmed upload; server and edge maps are kept. `@bugsee/bundler-plugin-core` exports `stampAssets`, `AssetStore`, `notify`, `resolveIdentity`, `loadBuildPluginEnv` and `mergeBuildPluginEnv` for it.
