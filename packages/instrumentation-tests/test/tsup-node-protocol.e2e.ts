// Regression guard for the `removeNodeProtocol` build defect (samples/angular-spa/FINDINGS.md F-2).
//
// tsup defaults `removeNodeProtocol` to `true` (node_modules/tsup/dist/index.js: the flag gates
// `nodeProtocolPlugin()`, default `true`), which silently rewrites every statically-resolvable
// `node:`-prefixed builtin import/require/dynamic-import in the emitted `dist/` to a bare specifier.
// `tsup.config.base.ts` (the ONE shared preset every package's `tsup.config.ts` spreads) now sets
// `removeNodeProtocol: false` to stop that — this test proves the real build pipeline honours it.
//
// This spawns the REAL `tsup` CLI against REAL package configs (not synthetic fixtures and not a
// re-implementation of tsup's resolution), and reads the actual emitted `dist/` files — the same
// "assert the emitted artifact, not a proxy for it" discipline `edge-bundle.ts`/`webview-bundle.e2e.ts`
// use for their own artifacts. Output goes to a scratch `--out-dir` per package so this never touches
// any package's own checked-in `dist/`.
//
// COVERAGE: the original guard checked exactly one specifier (`node:async_hooks`) in exactly one
// package (`@bugsee/cloudflare`) — narrow enough that a regression confined to, say, `@bugsee/deno`'s
// `node:process` import would sail through green. This is table-driven across EVERY package verified
// to import a `node:`-prefixed builtin — statically OR dynamically — from its own (non-test,
// non-string-embedded) source AND built via tsup + `baseConfig` (i.e. published, not a dev-only/no-build
// package): `@bugsee/cloudflare`, `@bugsee/node`, `@bugsee/node-utils`, `@bugsee/bun`, `@bugsee/deno`,
// `@bugsee/electron`, `@bugsee/bundler-plugin-core`, `@bugsee/nestjs`, `@bugsee/remix`.
//
// The population was derived by scanning every `packages/*/src` tree (excluding `.test.`/`.fuzz.`/
// `.e2e.` files) for THREE forms of `node:`-prefixed reference: static `from '...'`, `require('...')`,
// AND dynamic `import('...')` — the last of which R3-8 found this guard originally missed entirely,
// because its stated derivation method (grepping only for the static `from`/`require` forms) is
// structurally blind to a specifier that only ever appears as a dynamic-import argument (the case R3-8
// found was `@bugsee/util`'s old sha256 fallback, `await import(/* ...ignore comments... */ 'node:crypto')`,
// since deleted — util is now asserted to carry NO `node:` specifier at all, see the last test). The scan
// reads WHOLE FILE CONTENTS (not line-by-line — a dynamic import's magic comments and specifier commonly
// span multiple lines), so a single-line `grep` cannot reproduce it; the script is
// `.session-artifacts/derive-node-protocol-targets.py` (gitignored, kept for re-runs). For each hit, the source was
// read to confirm it is a real import reachable from the module graph — not a comment, an error-message
// string, or text embedded in a worker-thread bootstrap template literal run via `{ eval: true }`
// (`packages/node/src/liveness-heartbeat.ts`'s `WORKER_SCRIPT`, `packages/node/src/event-loop-watchdog.ts`,
// `packages/node-utils/src/worker-ring-worker.ts` each contain a `require`/`import` of a `node:` specifier
// INSIDE their `WORKER_SCRIPT`/`RING_IO_WORKER` string — that text is just characters to esbuild, never a
// resolvable import, so it needs no guard entry of its own; each already has a real static import of the
// same specifier elsewhere in the same file, so the corresponding package/specifier is still covered) —
// and confirming the owning package actually ships via `tsup.config.ts` + `baseConfig` (a package with no
// `tsup.config.ts` — e.g. `@bugsee/e2e-kit` — never runs through this pipeline and is excluded on that
// basis alone, regardless of what its src imports).
//
// EXCLUDED after that check:
//  - `@bugsee/vercel-edge` — every `node:async_hooks` mention in its src is inside a comment or an
//    error-message string, never a real import; that tier deliberately cannot import it, see
//    packages/vercel-edge/src/request-context-store.ts.
//  - `@bugsee/e2e-kit` — statically imports `node:http`/`node:net` (src/collector.ts) but has no
//    `tsup.config.ts`/build script; it is a test-only dev dependency, never published through tsup.
//  - `@bugsee/webview`'s SECOND (IIFE) build target — deliberately does NOT spread `baseConfig` and
//    relies on `removeNodeProtocol` defaulting to `true`, because tsup skips `externalPlugin` entirely
//    for `format: 'iife'` (see packages/webview/tsup.config.ts's comment). Its FIRST target (the dual
//    ESM+CJS entry) spreads `baseConfig` like everything else, but nothing in `@bugsee/webview`'s own
//    src statically imports a `node:` builtin, so it has no table entry either way.
//
// ENTRY-FILE COVERAGE: a package can declare MULTIPLE tsup entries (`tsup.config.ts`'s `entry: [...]`),
// and a `node:` import only lands in the specific emitted entry file(s) that reach it through the
// module graph — not necessarily `index.js`/`index.cjs`. `@bugsee/electron` is the proof case: its
// `node:fs`/`node:path` import (src/native-crash-source.ts) is reachable ONLY from the `main` entry
// (src/main.ts, the Node-process surface) — `index.js`/`index.cjs` never mention `fs` or `path` at all,
// built either way. A guard that only ever reads `index.js`/`index.cjs` (the original shape of this
// file) would stay green through a regression confined to `main.js`/`main.cjs`, because it never looks
// at the file the regression is in. Each target below therefore names the entry basename(s) (relative
// to the package's own `tsup.config.ts` `entry` array) that its specifiers actually land in — verified
// by building the package and grepping every emitted `<entry>.js`/`<entry>.cjs`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const tsupBin = join(repoRoot, 'node_modules/.bin/tsup');

// A wedged build must not hold the shared CI runner hostage (its job cap is 30 minutes). Each of these
// builds a single small-to-medium package and completes in low single-digit seconds locally; 2 minutes
// is generous headroom for a loaded CI box while still failing long before the job-level cap.
const BUILD_TIMEOUT_MS = 120_000;

interface NodeProtocolTarget {
  /** Human-readable label for describe/it blocks and failure messages. */
  readonly label: string;
  /** Package directory, relative to the repo root. */
  readonly pkgDir: string;
  /** `node:`-prefixed specifiers this package's own source statically imports/requires. */
  readonly specifiers: readonly string[];
  /**
   * Entry basenames (matching `tsup.config.ts`'s `entry` array, without extension) whose emitted
   * `<name>.js`/`<name>.cjs` actually carry `specifiers` — verified by building the package and
   * grepping the real dist. Defaults to `['index']`, the single-entry common case. A multi-entry
   * package (electron, remix) may build MORE files than are listed here; only the listed ones are
   * asserted on, because those are the only ones a `node:` import from src was confirmed to reach.
   */
  readonly entryNames?: readonly string[];
}

// Population verified by building each package and reading its emitted dist (see the method note
// above) — every entry here is a REAL static `import`/`require` in the package's own (non-test) src,
// not a specifier that only appears in a comment, an error string, or a worker-script template literal.
const targets: readonly NodeProtocolTarget[] = [
  {
    label: '@bugsee/cloudflare',
    pkgDir: 'packages/cloudflare',
    specifiers: ['node:async_hooks'],
  },
  {
    label: '@bugsee/node',
    pkgDir: 'packages/node',
    specifiers: ['node:fs', 'node:http', 'node:crypto', 'node:worker_threads'],
  },
  {
    label: '@bugsee/node-utils',
    pkgDir: 'packages/node-utils',
    // node:crypto: src/sha256.ts, the upload-checksum digest @bugsee/node injects where WebCrypto is absent.
    specifiers: [
      'node:fs',
      'node:http',
      'node:https',
      'node:zlib',
      'node:worker_threads',
      'node:crypto',
    ],
  },
  {
    label: '@bugsee/bun',
    pkgDir: 'packages/bun',
    specifiers: ['node:process'],
  },
  {
    label: '@bugsee/deno',
    pkgDir: 'packages/deno',
    specifiers: ['node:process'],
  },
  {
    // src/native-crash-source.ts imports node:fs + node:path, reachable only via src/main.ts (the
    // Node-process entry) — main-imports-it -> launch-main.ts imports it -> main.ts imports launch-main.
    // NOT reachable from index.ts/renderer.ts/preload.ts (verified: neither `fs` nor `path` appears
    // anywhere in a built index.js/index.cjs).
    label: '@bugsee/electron',
    pkgDir: 'packages/electron',
    specifiers: ['node:fs', 'node:path'],
    entryNames: ['main'],
  },
  {
    // orchestrate.ts (node:fs/promises, node:path) and run-cli.ts (node:child_process, node:module) are
    // both reached from the package's single entry, src/index.ts.
    label: '@bugsee/bundler-plugin-core',
    pkgDir: 'packages/bundler-plugin-core',
    specifiers: ['node:fs/promises', 'node:path', 'node:child_process', 'node:module'],
  },
  {
    // src/middleware.ts imports node:crypto, reached from the package's single entry, src/index.ts.
    label: '@bugsee/nestjs',
    pkgDir: 'packages/nestjs',
    specifiers: ['node:crypto'],
  },
  {
    // src/meta-tag-transformer.ts imports node:stream, exported ONLY from src/server.ts (the node-only
    // entry — docs/design/meta-framework-adapters.md's per-runtime entry split). NOT reachable from
    // index.ts (portable) or client.ts (browser-only) — verified: neither built index/client file
    // mentions `stream` in any form.
    label: '@bugsee/remix',
    pkgDir: 'packages/remix',
    specifiers: ['node:stream'],
    entryNames: ['server'],
  },
];

/**
 * Every module specifier a `from '...'` (ESM), `require('...')` (CJS), or dynamic `import('...')`
 * reaches for in `code`. The dynamic form must tolerate the magic comments (`webpackIgnore`,
 * `turbopackIgnore`, `@vite-ignore`) and line breaks tsup/esbuild preserve between `import(` and the
 * specifier — a dynamic import with magic comments can span several lines in emitted output — so this
 * scans the whole file content, not line-by-line.
 */
function importSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specifiers.push(m[1] as string);
  for (const m of code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g))
    specifiers.push(m[1] as string);
  for (const m of code.matchAll(/\bimport\(\s*(?:\/\*[^*]*\*\/\s*)*['"]([^'"]+)['"]/g))
    specifiers.push(m[1] as string);
  return specifiers;
}

describe('tsup build config — node: protocol survives into dist (F-2 regression guard)', () => {
  let outDir: string | undefined;

  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
    outDir = undefined;
  });

  for (const target of targets) {
    const entryNames = target.entryNames ?? ['index'];

    it(`${target.label}: emitted ${entryNames.join('/')} dist imports ${target.specifiers.join(', ')} verbatim, never bare`, () => {
      outDir = mkdtempSync(join(tmpdir(), 'bugsee-tsup-node-protocol-'));

      try {
        execFileSync(tsupBin, ['--out-dir', outDir], {
          cwd: join(repoRoot, target.pkgDir),
          stdio: 'pipe',
          timeout: BUILD_TIMEOUT_MS,
        });
      } catch (error) {
        // A wedged `tsup` process must not hold the shared CI runner to its 30-minute job cap — Node
        // kills the process and reports ETIMEDOUT on `timeout`, but that alone doesn't say WHICH build
        // hung or for how long, so make that explicit rather than making a debugger dig it out of a
        // generic "spawnSync tsup ETIMEDOUT".
        const { code, signal } = error as NodeJS.ErrnoException & {
          signal?: NodeJS.Signals | null;
        };
        const timedOut = code === 'ETIMEDOUT' || signal === 'SIGTERM';
        if (timedOut) {
          throw new Error(
            `${target.label}: tsup build did not finish within ${BUILD_TIMEOUT_MS}ms and was killed ` +
              `(signal ${signal ?? 'unknown'}). This guard's build hung — investigate the tsup invocation ` +
              `for ${target.pkgDir}, it should normally complete in low single-digit seconds.`,
            { cause: error },
          );
        }
        throw error;
      }

      for (const entryName of entryNames) {
        const esmPath = join(outDir, `${entryName}.js`);
        const cjsPath = join(outDir, `${entryName}.cjs`);
        expect(existsSync(esmPath), `expected ${esmPath} to exist`).toBe(true);
        expect(existsSync(cjsPath), `expected ${cjsPath} to exist`).toBe(true);

        const esmSpecifiers = importSpecifiers(readFileSync(esmPath, 'utf8'));
        const cjsSpecifiers = importSpecifiers(readFileSync(cjsPath, 'utf8'));

        for (const specifier of target.specifiers) {
          const bareForm = specifier.slice('node:'.length);

          // Positive: the prefixed form must survive verbatim.
          expect(esmSpecifiers, `${target.label} ${entryName}.js`).toContain(specifier);
          expect(cjsSpecifiers, `${target.label} ${entryName}.cjs`).toContain(specifier);

          // Negative: the bare form (what tsup's removeNodeProtocol default produces) must be ABSENT —
          // not merely outnumbered. This is the assertion that fails red without the fix
          // (removeNodeProtocol: false in tsup.config.base.ts): tsup's nodeProtocolPlugin rewrites
          // e.g. node:async_hooks -> async_hooks wherever removeNodeProtocol is left at its default
          // `true`.
          expect(esmSpecifiers, `${target.label} ${entryName}.js`).not.toContain(bareForm);
          expect(cjsSpecifiers, `${target.label} ${entryName}.cjs`).not.toContain(bareForm);
        }
      }
    });
  }

  // The inverse guard. `@bugsee/util` is tier-0 and ships inside every browser, worker and edge bundle, where
  // ANY `node:` specifier — even an unreachable, ignore-commented dynamic import — breaks an esbuild build.
  // Its sha256 used to carry one (R3-8); the digest is now WebCrypto-only and node injects its own.
  it('@bugsee/util: emitted index dist carries no node: specifier in any form', () => {
    outDir = mkdtempSync(join(tmpdir(), 'bugsee-tsup-node-protocol-'));
    execFileSync(tsupBin, ['--out-dir', outDir], {
      cwd: join(repoRoot, 'packages/util'),
      stdio: 'pipe',
      timeout: BUILD_TIMEOUT_MS,
    });
    for (const file of ['index.js', 'index.cjs']) {
      const code = readFileSync(join(outDir, file), 'utf8');
      const specifiers = importSpecifiers(code);
      expect(
        specifiers.length,
        `${file} import scan found nothing — scan is broken`,
      ).toBeGreaterThan(0);
      expect(
        specifiers.filter((sp) => sp.startsWith('node:') || sp === 'crypto'),
        file,
      ).toEqual([]);
      expect(code, file).not.toContain('node:crypto');
    }
  });
});
