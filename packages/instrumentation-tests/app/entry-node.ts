// Node entry: the real @bugsee/node SDK under a real `node` process (run via tsx for TS).
import { launch } from '@bugsee/node';
import { runEntry } from './run-entry';

runEntry(launch);
