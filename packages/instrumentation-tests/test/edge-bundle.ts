import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

// Bundle an edge SDK package the way a real Worker / Edge bundler (wrangler / Vercel) would: a single
// minified ESM file with the WinterCG (browser-ish) platform and `node:*` builtins external — they're
// guarded dynamic imports (e.g. @bugsee/util sha256's `import('node:crypto')`) that never execute on edge,
// where globalThis.crypto.subtle exists. Used by BOTH the bundle-size guard (X2) and the real-edge VM smoke
// (X3, which evaluates the produced code in @edge-runtime/vm).

// instrumentation-tests dir — the resolveDir for the workspace package specifiers.
const packageDir = fileURLToPath(new URL('..', import.meta.url));

export interface EdgeBundle {
  /** The bundled, minified ESM source. */
  code: string;
  /**
   * The `node:*` builtins the bundle STATICALLY imports, from esbuild's metafile.
   *
   * Read from the metafile rather than regexed out of the minified source: source matching cannot tell an
   * import from a string that merely mentions one. It gave a false positive the moment a diagnostic message
   * contained the text `from "node:async_hooks"`, and it had already missed a real named import
   * (`import { X } from 'node:y'`) because the pattern only matched the bare side-effect form.
   */
  nodeImports: string[];
  /** Raw byte length. */
  bytes: number;
  /** gzipped byte length (what counts against the Workers compressed limit). */
  gzipBytes: number;
}

function measure(code: string, nodeImports: string[] = []): EdgeBundle {
  return {
    code,
    nodeImports,
    bytes: Buffer.byteLength(code, 'utf8'),
    gzipBytes: gzipSync(Buffer.from(code, 'utf8')).length,
  };
}

/**
 * The STATIC `node:*` imports esbuild recorded for the built output.
 *
 * `kind` distinguishes an `import-statement` from a `dynamic-import`. Only static imports matter here: a
 * guarded dynamic `import('node:crypto')` — e.g. @bugsee/util's sha256 fallback — never executes on edge,
 * where `globalThis.crypto.subtle` exists, so it must not fail the guard.
 */
function nodeImportsOf(metafile: {
  outputs: Record<string, { imports?: Array<{ path: string; kind?: string }> }>;
}): string[] {
  const found = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.path.startsWith('node:') && imported.kind === 'import-statement') {
        found.add(imported.path);
      }
    }
  }
  return [...found].sort();
}

// Models a `nodejs_compat`-enabled Worker for the VM smoke. @edge-runtime/vm is a bare WinterCG isolate with
// no node builtins, but @bugsee/cloudflare legitimately imports `node:async_hooks` (the ONLY route to
// AsyncLocalStorage on workerd — Wave 0.1 S0). Without this the smoke would test an environment Cloudflare
// users never deploy to. A single-slot stand-in is enough here: the smoke asserts the assembled SDK RUNS and
// uploads; real ALS propagation is proven on real workerd by the miniflare e2e.
const NODEJS_COMPAT_SHIM = `
  export class AsyncLocalStorage {
    #slot;
    getStore() { return this.#slot; }
    run(store, fn) { const prev = this.#slot; this.#slot = store; try { return fn(); } finally { this.#slot = prev; } }
  }
`;

const nodejsCompatPlugin = {
  name: 'nodejs-compat-shim',
  setup(build: { onResolve: Function; onLoad: Function }) {
    build.onResolve({ filter: /^node:async_hooks$/ }, () => ({
      path: 'node:async_hooks',
      namespace: 'nodejs-compat',
    }));
    build.onLoad({ filter: /.*/, namespace: 'nodejs-compat' }, () => ({
      contents: NODEJS_COMPAT_SHIM,
      loader: 'ts' as const,
    }));
  },
};

/** Bundle arbitrary edge entry source (a re-export of a package, or a self-contained scenario). */
export async function bundleEdgeSource(contents: string): Promise<EdgeBundle> {
  const result = await build({
    stdin: { contents, resolveDir: packageDir, loader: 'ts', sourcefile: 'edge-entry.ts' },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['node:*'], // guarded dynamic imports — never run on edge
    legalComments: 'none',
    metafile: true,
    write: false,
  });
  return measure(result.outputFiles[0]?.text ?? '', nodeImportsOf(result.metafile));
}

/** Bundle an entry FILE (e.g. the VM smoke scenario, or the @bugsee/webview injectable IIFE). `iife` produces a
 *  script that runs on evaluate (so it can be run via @edge-runtime/vm's `evaluate`, which executes a script —
 *  not an ES module). Pass `globalName` to publish the entry's exports as a global (the webview injectable build
 *  exposes `BugseeWebView`); both edge + webview bundles target the browser platform with `node:*` external. */
export async function bundleEdgeEntry(
  entryFile: string,
  format: 'esm' | 'iife' = 'esm',
  globalName?: string,
): Promise<EdgeBundle> {
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    minify: true,
    format,
    platform: 'browser',
    target: 'es2022',
    external: ['node:*'],
    // The VM smoke runs in a bare WinterCG isolate; shim node:async_hooks so it models a
    // nodejs_compat-enabled Worker (what @bugsee/cloudflare actually requires).
    plugins: [nodejsCompatPlugin],
    legalComments: 'none',
    metafile: true,
    write: false,
    ...(globalName !== undefined ? { globalName } : {}),
  });
  return measure(result.outputFiles[0]?.text ?? '', nodeImportsOf(result.metafile));
}

/** Bundle a whole package's public surface (`export *`) — the conservative upper bound for the size guard. */
export function bundleEdgePackage(packageName: string): Promise<EdgeBundle> {
  return bundleEdgeSource(`export * from '${packageName}';`);
}

/**
 * Bundle a Worker entry for REAL workerd (miniflare).
 *
 * Unlike the VM-smoke bundler this does NOT shim `node:async_hooks`: workerd with `nodejs_compat` provides
 * the real module, and shimming it would defeat the point of running on the real runtime. It stays external
 * so workerd resolves it at load.
 */
export async function bundleWorkerEntry(entryFile: string): Promise<string> {
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    minify: false, // readable in failure output
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['node:*'],
    legalComments: 'none',
    write: false,
  });
  return result.outputFiles[0]?.text ?? '';
}
