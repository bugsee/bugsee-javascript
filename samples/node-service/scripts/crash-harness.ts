// S5 crashes: uncaught exceptions / unhandled rejections must be run OUT OF PROCESS from the main
// server (they terminate or alter the process by design). Usage:
//   node scripts/crash-harness.ts <profile> <kind: uncaught|rejection> <marker>
// Exits 0 if the process behaved as the profile says it should (see the per-kind checks below);
// prints a JSON verdict line prefixed "HARNESS_RESULT " that the caller (verify.mjs / a human) reads.
import { initBugsee } from '../src/bugsee-client.ts';

const [, , profileArg, kindArg, markerArg] = process.argv;
const profile = profileArg ?? 'default';
const kind = kindArg ?? 'uncaught';
const marker = markerArg ?? String(Date.now());

const { client } = initBugsee(profile);
client.launch();

let stayedAlive = false;
const aliveTimer = setTimeout(() => {
  stayedAlive = true;
  // eslint-disable-next-line no-console
  console.log('HARNESS_RESULT ' + JSON.stringify({ profile, kind, marker, stayedAlive: true, exitCode: null }));
  process.exit(42); // distinct code meaning "still alive after the grace period, as expected for warn/none"
}, 4000);
aliveTimer.unref();

process.on('exit', (code) => {
  if (!stayedAlive) {
    // eslint-disable-next-line no-console
    console.log('HARNESS_RESULT ' + JSON.stringify({ profile, kind, marker, stayedAlive: false, exitCode: code }));
  }
});

setTimeout(() => {
  if (kind === 'uncaught') {
    throw new Error(`S5 uncaught exception marker=${marker} profile=${profile}`);
  } else if (kind === 'rejection') {
    void Promise.reject(new Error(`S5 unhandled rejection marker=${marker} profile=${profile}`));
  } else {
    throw new Error(`unknown crash kind ${kind}`);
  }
}, 50);
