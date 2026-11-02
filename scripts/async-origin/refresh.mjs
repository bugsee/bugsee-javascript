// Regenerates packages/capture/spec/dom-promise-methods.snapshot.json from the installed TypeScript's lib.dom.d.ts.
// Run after a TypeScript upgrade (`pnpm async-origin:refresh`), then classify any new method in
// packages/capture/src/async-origin-table.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDomPromiseMethods } from './extract.mjs';

const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'capture',
  'spec',
  'dom-promise-methods.snapshot.json',
);
mkdirSync(dirname(target), { recursive: true });
const snapshot = extractDomPromiseMethods();
writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
const names = Object.values(snapshot.interfaces);
console.log(
  `typescript ${snapshot.typescript}: ${names.length} interfaces, ${names.reduce((n, i) => n + i.methods.length, 0)} methods`,
);
