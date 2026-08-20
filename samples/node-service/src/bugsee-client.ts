// Bugsee wiring for the "Link shortener" sample — config-file-driven so the whole option surface of
// packages/node/src/launch.ts (via the @bugsee/bugsee umbrella `./node` entry) can be exercised by
// relaunching with a different BUGSEE_PROFILE, without touching code. See config/launch.*.json.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BugseeNodeLaunchOptions } from '@bugsee/bugsee/node';
import { launch } from '@bugsee/bugsee/node';
import type { Bugsee } from '@bugsee/node';
import { httpRequest } from '@bugsee/node-utils';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

/** Bump a small on-disk counter each process start — becomes `appBuild`, so runs are distinguishable
 *  in the Bugsee dashboard (§3 convention: appVersion + appBuild identify issues). */
function nextBuildNumber(): string {
  const path = join(root, 'data', 'build-counter.json');
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let n = 0;
  if (existsSync(path)) {
    try {
      n = (JSON.parse(readFileSync(path, 'utf8')) as { n: number }).n;
    } catch {
      n = 0;
    }
  }
  n += 1;
  writeFileSync(path, JSON.stringify({ n }));
  return String(n);
}

export function loadProfile(name: string): Record<string, unknown> {
  const path = join(root, 'config', `launch.${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`unknown BUGSEE_PROFILE '${name}' — no ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const { _comment, ...options } = raw;
  void _comment;
  return options;
}

/**
 * Wire-level (§4 depth 2) evidence: a passthrough wrapper around the REAL node-utils transport that
 * appends every request/response the SDK's own control-plane + upload client makes to an ndjson file.
 * Used by scripts/verify.ts to prove "the right thing left the process" even where the backend cannot
 * be asserted directly (see FINDINGS.md — the staging 'javascript' app-type gap blocks live
 * confirmation via MCP). Enabled by setting BUGSEE_WIRE_LOG to a file path.
 */
function wireLoggingTransport(logPath: string): BugseeNodeLaunchOptions['transport'] {
  return (async (url, options) => {
    const response = await httpRequest(url, options);
    try {
      const bodyText =
        options.body !== undefined
          ? Buffer.isBuffer(options.body)
            ? options.body.toString('utf8')
            : String(options.body)
          : null;
      appendFileSync(
        logPath,
        `${JSON.stringify({
          at: Date.now(),
          method: options.method,
          url,
          requestHeaders: options.headers,
          requestBody: bodyText,
          status: response.status,
          responseBody: Buffer.from(response.body).toString('utf8').slice(0, 4000),
        })}\n`,
      );
    } catch {
      /* best-effort diagnostic logging only — never affect SDK behaviour */
    }
    return response;
  }) as BugseeNodeLaunchOptions['transport'];
}

export interface InitResult {
  client: Bugsee;
  profile: string;
  appBuild: string;
}

/** Build the full BugseeLaunchOptions for the given profile, applying the env-var overrides the
 *  verify/multi-instance/recovery scripts use to steer specific fields without a new profile file. */
export function buildOptions(profileName: string): { options: BugseeNodeLaunchOptions; appBuild: string } {
  const token = process.env.BUGSEE_APP_TOKEN;
  if (!token) throw new Error('BUGSEE_APP_TOKEN is not set (see .env.example)');
  const endpoint = process.env.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com';
  if (endpoint.includes('api.bugsee.com') && !endpoint.includes('apidev')) {
    throw new Error('refusing to launch against production api.bugsee.com — use staging');
  }

  const profileOptions = loadProfile(profileName);
  const appBuild = process.env.BUGSEE_APP_BUILD ?? nextBuildNumber();

  const options: BugseeNodeLaunchOptions = {
    endpoint,
    appId: 'link-shortener',
    appVersion: '1.0.0',
    appBuild,
    onError: (error) => {
      // eslint-disable-next-line no-console
      console.error('[bugsee:onError]', error);
    },
    ...profileOptions,
  };

  // Env overrides used by the out-of-process scripts (multi-instance / recovery) so they can steer one
  // field (a shared dataDir, or instrumentIncomingRequests) without forking a new profile file.
  if (process.env.BUGSEE_DATA_DIR !== undefined) {
    options.dataDir = process.env.BUGSEE_DATA_DIR;
  }
  if (process.env.BUGSEE_INSTRUMENT_INCOMING !== undefined) {
    options.instrumentIncomingRequests = process.env.BUGSEE_INSTRUMENT_INCOMING === 'true';
  }
  if (process.env.BUGSEE_WIRE_LOG !== undefined) {
    options.transport = wireLoggingTransport(process.env.BUGSEE_WIRE_LOG);
  }

  return { options, appBuild };
}

export function initBugsee(
  profileName = process.env.BUGSEE_PROFILE ?? 'default',
  extra: Partial<BugseeNodeLaunchOptions> = {},
): InitResult {
  const { options, appBuild } = buildOptions(profileName);
  const client = launch(process.env.BUGSEE_APP_TOKEN as string, { ...options, ...extra });
  client.setUserIdentifier('sample-user@bugsee.dev');
  client.setAttribute('sample.name', 'node-service');
  client.setAttribute('sample.profile', profileName);
  client.setAttribute('sample.pid', process.pid);
  return { client, profile: profileName, appBuild };
}
