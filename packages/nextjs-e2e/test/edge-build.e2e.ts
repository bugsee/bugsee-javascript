// WAVE 3b.5 — @bugsee/nextjs against a REAL `next` build.
//
// There was no `next` installed anywhere in the monorepo, so the adapter had never been compiled by the
// framework it adapts. Everything about it was verified against hand-written fakes of Next's seams.
//
// The thing a fake cannot model is the one that matters here: Next compiles `instrumentation.ts` for BOTH
// the `server` and the `edge-server` compilations, and the edge compilation must BUNDLE everything it can
// reach, because an edge isolate has no `node_modules` resolution. So anything statically reachable from
// `register()` — including the branch that can never execute on edge — is pulled into the edge graph.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(appDir, '.next');
const edgeInstrumentation = join(outDir, 'server', 'edge-instrumentation.js');

/** Every file under `dir`, recursively. */
const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      })
    : [];

describe('@bugsee/nextjs — real `next build`', () => {
  let build: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    build = spawnSync('pnpm', ['exec', 'next', 'build'], {
      cwd: appDir,
      encoding: 'utf8',
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    });
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('compiles at all — the edge compilation resolves every module it reached', () => {
    // The headline defect: `register()` dispatches with `await import('@bugsee/nextjs/server')`, a static
    // literal specifier that every bundler follows. Compiled for edge, that drags @bugsee/node,
    // @bugsee/node-utils and a dozen `node:*` builtins into a graph that cannot resolve them.
    const output = `${build.stdout ?? ''}\n${build.stderr ?? ''}`;
    expect(build.status, `next build failed:\n${output.split('\n').slice(-60).join('\n')}`).toBe(0);
  });

  it('wires the EDGE composition into the edge compilation', () => {
    // `instrumentation.ts` is compiled separately for edge, into `.next/server/edge-instrumentation.js`.
    // The edge branch must be there — otherwise "no node code in the edge bundle" is trivially satisfied
    // by an edge bundle containing no Bugsee at all.
    expect(existsSync(edgeInstrumentation), 'no edge instrumentation bundle was produced').toBe(
      true,
    );
    expect(readFileSync(edgeInstrumentation, 'utf8')).toContain('registerEdge');
  });

  it('keeps the NODE composition out of the edge compilation', () => {
    // The defect, asserted on the artifact: the `NEXT_RUNTIME === 'nodejs'` branch can never EXECUTE on
    // edge, but it was being COMPILED into the edge graph, dragging @bugsee/node behind it.
    const text = readFileSync(edgeInstrumentation, 'utf8');
    for (const marker of [
      'registerServer',
      'createBatchedFsChunkStorage', // @bugsee/node-utils fs storage
      'startProfiling', // the V8 CPU profiler, which is what reached node:inspector
    ]) {
      expect(text.includes(marker), `the edge bundle carries the node-only \`${marker}\``).toBe(
        false,
      );
    }
  });

  it('has no STATIC node: require anywhere in the edge output', () => {
    // A static `require("node:…")` in an edge chunk cannot resolve at runtime. (@bugsee/util's SHA-256 once
    // carried an ignore-marked dynamic `import("node:crypto")` fallback; it is gone — util is WebCrypto-only
    // and @bugsee/node injects a node:crypto digest where WebCrypto is absent.)
    const offenders: string[] = [];
    for (const file of walk(join(outDir, 'server')).filter((f) => f.endsWith('.js'))) {
      const text = readFileSync(file, 'utf8');
      if (!file.includes('edge')) continue; // node-server chunks may legitimately require node builtins
      if (/require\(["']node:[a-z_/]+["']\)/.test(text)) {
        offenders.push(file.slice(outDir.length + 1));
      }
    }
    expect(offenders, 'static node: requires reached the edge output').toEqual([]);
  });
});
