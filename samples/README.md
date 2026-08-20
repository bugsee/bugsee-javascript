# Bugsee JavaScript SDK — sample applications

Each subfolder is a **standalone, runnable application** that uses one part of the Bugsee JavaScript
SDK. Pick the one that matches your stack, set an app token, run one command.

They are also how we verify the SDK before publishing: each sample installs the SDK from a
pre-publish tarball (the real `dist` + `exports` map, not the monorepo source), exercises every API
and capture source it can reach, and checks that the data actually arrives on the Bugsee backend.
Anything that does not is written down in that sample's `FINDINGS.md`.

## Run a sample

```bash
cd samples/<name>
cp .env.example .env      # paste your Bugsee app token into BUGSEE_APP_TOKEN
pnpm install
pnpm dev
```

Each sample's own `README.md` has the exact commands, what the app does, and a table mapping every
scenario to the control that triggers it.

## Working on the samples (maintainers)

Samples do **not** live in the monorepo pnpm workspace. Each is its own pnpm project with its own
lockfile, so parallel work on several samples never contends on the root lockfile, and so each sample
really is something a customer can copy out of the repo.

They resolve `@bugsee/*` from local tarballs:

```bash
node scripts/pack-local.mjs                       # build + pack every package to .local-registry/
node scripts/new-sample.mjs <name> "@bugsee/x"    # scaffold a new sample
cd samples/<name> && pnpm install
```

After changing anything under `packages/`, re-pack (`--only @bugsee/x` for a single package) and
re-run `pnpm install` in the sample.

The plan every sample is built against — the package sweep, the scenario catalog, the per-sample
coverage and the backend verification protocol — is `docs/samples/PLAN.md`.

## Findings

- `samples/FINDINGS.md` — cross-cutting findings, and the aggregate index.
- `samples/<name>/FINDINGS.md` — findings from that sample.

Sample authors record defects; they do not fix SDK code.
