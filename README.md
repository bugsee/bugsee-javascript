# Bugsee JavaScript SDK

A single SDK targeting every JavaScript runtime — browsers, Node.js, Bun, Deno, Electron, Cloudflare Workers, Vercel Edge, and Web/Service Workers.

> **Status:** implemented. Runnable SDKs exist for every target runtime, plus frontend, meta-framework and
> backend adapters, session replay, APM, OpenTelemetry and source-map tooling. Development follows test-first
> practice with a per-entity mutation check.

## Layout

`packages/*` — the SDK packages, from the foundation tier (types, util, logger, protocol) through the kernel,
the platform SDKs, the framework adapters and the umbrella package.

## Develop

```sh
corepack enable pnpm   # pnpm via corepack (see packageManager in package.json)
pnpm install
pnpm typecheck         # turbo run typecheck across packages
pnpm test              # vitest
pnpm lint              # biome
pnpm check:cycles      # madge --circular
```
