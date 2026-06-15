// Bun entry: the real @bugsee/bun SDK under a real `bun` process (native TS).
import { launch } from '@bugsee/bun';
import { runEntry } from './run-entry';

runEntry(launch);
