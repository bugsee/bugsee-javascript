import { launchCore } from '@bugsee/bun';
import type { Bugsee } from '@bugsee/node';
import { type BugseeServerLaunchOptions, createServerLaunch } from './server-launch';

// The `bugsee` umbrella launch() for BUN — selected via the package `exports` "bun" condition, which must
// be listed BEFORE "node" because Bun sets both.
//
// Without this entry the umbrella resolved to @bugsee/node on Bun, and a customer on the documented
// single-install path silently lost every Bun-specific default: the `Bun.serve` interceptor (so idiomatic
// `Bun.serve({fetch})` apps, which bypass node:http entirely, were NOT instrumented), the guarded
// perf_hooks metrics sampler, and the runtime identity — reports said `node` 24.3.0 for Bun 1.3.14.

export type BugseeBunLaunchOptions = BugseeServerLaunchOptions;

export const launch: (appToken: string, options?: BugseeBunLaunchOptions) => Bugsee =
  createServerLaunch(launchCore);
