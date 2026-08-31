#!/usr/bin/env node
// A build counter so every production build we upload for is identifiable in the dashboard
// (`appBuild`), matching the other samples' convention (e.g. react-spa's vite.config.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const counterFile = `${root}/.build-counter`;

let n = 0;
if (existsSync(counterFile)) {
  n = Number.parseInt(readFileSync(counterFile, 'utf8').trim(), 10) || 0;
}
n += 1;
writeFileSync(counterFile, String(n));
// eslint-disable-next-line no-console
console.log(`[bump-build-counter] appBuild = ${n}`);
