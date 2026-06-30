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
  /** Raw byte length. */
  bytes: number;
  /** gzipped byte length (what counts against the Workers compressed limit). */
  gzipBytes: number;
}

function measure(code: string): EdgeBundle {
  return {
    code,
    bytes: Buffer.byteLength(code, 'utf8'),
    gzipBytes: gzipSync(Buffer.from(code, 'utf8')).length,
  };
}

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
    write: false,
  });
  return measure(result.outputFiles[0]?.text ?? '');
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
    legalComments: 'none',
    write: false,
    ...(globalName !== undefined ? { globalName } : {}),
  });
  return measure(result.outputFiles[0]?.text ?? '');
}

/** Bundle a whole package's public surface (`export *`) — the conservative upper bound for the size guard. */
export function bundleEdgePackage(packageName: string): Promise<EdgeBundle> {
  return bundleEdgeSource(`export * from '${packageName}';`);
}
