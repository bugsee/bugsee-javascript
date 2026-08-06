import { launchCore } from '@bugsee/deno';
import type { Bugsee } from '@bugsee/node';
import { type BugseeServerLaunchOptions, createServerLaunch } from './server-launch';

// The `bugsee` umbrella launch() for DENO — selected via the package `exports` "deno" condition, which must
// be listed BEFORE "node" because Deno sets both under node compatibility.
//
// Without this entry the umbrella resolved to @bugsee/node on Deno, silently losing the `Deno.serve`
// interceptor, the guarded metrics sampler, and the runtime identity — reports said `node` 24.15.0 for
// Deno 2.8.3.

export type BugseeDenoLaunchOptions = BugseeServerLaunchOptions;

export const launch: (appToken: string, options?: BugseeDenoLaunchOptions) => Bugsee =
  createServerLaunch(launchCore);
