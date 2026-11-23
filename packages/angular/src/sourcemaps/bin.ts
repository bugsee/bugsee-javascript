#!/usr/bin/env node
/* v8 ignore start -- the executable shell: the logic is in cli.ts (unit-tested); the built bin is exercised by
   the real-build test (angular.real-build.test.ts), which runs in a child process coverage does not see. */
import { runCli } from './cli';

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
});
/* v8 ignore stop */
