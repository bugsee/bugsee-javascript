# Bugsee JavaScript SDK

A single SDK targeting every JavaScript runtime — browsers, Node.js, Bun, Deno, Electron, Cloudflare Workers, Vercel Edge, and Web/Service Workers.

> **Status:** implemented. Runnable SDKs exist for every target runtime, plus frontend, meta-framework and
> backend adapters, session replay, APM, OpenTelemetry and source-map tooling. Implementation state is tracked
> in [`docs/PROGRESS.md`](docs/PROGRESS.md) (read it first); all code follows the binding standards in
> [`docs/implementation-standards.md`](docs/implementation-standards.md) (test-first TDD + per-entity mutator loop).

## Docs

- [`docs/PROGRESS.md`](docs/PROGRESS.md) — **what is implemented** (the hand-off doc; read first).
- [`docs/design/sdk-design.md`](docs/design/sdk-design.md) — architecture & design (Draft v3). Android-canonical; thin kernel + pub/sub event flow (§16). Read alongside `PROGRESS.md` for the as-built deltas.
- [`docs/implementation-standards.md`](docs/implementation-standards.md) — testing & coding standards (binding).
- [`docs/dev-environment.md`](docs/dev-environment.md) — toolchain reference.
- [`CLAUDE.md`](CLAUDE.md) — guidance for AI agents working in this repo.

## Layout

`packages/*` — the SDK packages across tiers 0–5 (foundation → kernel → platform → mid-tier → framework adapters → umbrella). See design §5.

## Develop

```sh
corepack enable pnpm   # pnpm via corepack (see packageManager in package.json)
pnpm install
pnpm typecheck         # turbo run typecheck across packages
pnpm test              # vitest
pnpm lint              # biome
pnpm check:cycles      # madge --circular
```
