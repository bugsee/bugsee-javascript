// Deno entry: the real @bugsee/deno SDK under a real `deno` process (native TS, node-compat).
import { launch } from '@bugsee/deno';
import { runEntry } from './run-entry';

runEntry(launch);
