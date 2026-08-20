// A disposable process for the crash-exit-behavior scenarios that CANNOT be exercised inside the
// long-running verify server (they terminate the process): exitOnUncaught / unhandledRejections modes.
// scripts/verify.ts spawns this once per mode and asserts on the exit code + timing.
//
// Usage: tsx scripts/crash-child.ts <mode> <marker>
//   mode: 'uncaught-exit' | 'uncaught-no-exit' | 'rejection-preserve' | 'rejection-warn' | 'rejection-none'
import 'dotenv/config';
import { launch } from '@bugsee/express';
import { createTeeTransport } from '../src/bugsee-transport';

const [mode, marker] = process.argv.slice(2);
const appToken = process.env.BUGSEE_APP_TOKEN as string;

const client = launch(appToken, {
  endpoint: process.env.BUGSEE_ENDPOINT,
  sdkVersion: '1.0.0', // F-1 workaround — see src/bugsee.ts + FINDINGS.md
  appVersion: '1.0.0',
  appBuild: 'crash-child',
  capturedDataStore: 'memory',
  detectHangs: false,
  instrumentIncomingRequests: false,
  transport: createTeeTransport() as never,
  exitOnUncaught: mode === 'uncaught-no-exit' ? false : true,
  unhandledRejections:
    mode === 'rejection-warn' ? 'warn' : mode === 'rejection-none' ? 'none' : 'preserve',
});

console.log(`crash-child ready mode=${mode} marker=${marker}`);

if (mode.startsWith('uncaught')) {
  setTimeout(() => {
    throw new Error(`crash-child-uncaught-${mode}-${marker}`);
  }, 50);
  if (mode === 'uncaught-no-exit') {
    // exitOnUncaught:false must NOT exit on its own — bound the test with our OWN exit instead of
    // hanging the verify.ts child-process wait forever. Exit code 7 marks "still alive, we killed it".
    setTimeout(() => {
      console.log('crash-child still alive after uncaught exception (exitOnUncaught:false)');
      process.exit(7);
    }, 1000);
  }
} else {
  setTimeout(() => {
    void Promise.reject(new Error(`crash-child-rejection-${mode}-${marker}`));
  }, 50);
  if (mode === 'rejection-none') {
    // 'none' installs NO listener — Node's own default (crash) applies. Give the flush a moment first
    // in case Node's default doesn't fire for some reason, so the process still exits deterministically.
    setTimeout(() => {
      void client.flush(2000).then(() => process.exit(3));
    }, 500);
  } else if (mode === 'rejection-warn') {
    // 'warn' must NOT exit — prove it by staying alive past the point an exit would have happened.
    setTimeout(() => {
      console.log('crash-child still alive after warn-mode rejection');
      process.exit(42);
    }, 1000);
  }
}
