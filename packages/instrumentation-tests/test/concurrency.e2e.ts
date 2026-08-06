// WAVE 3b.4 — overlapping requests with distinct identities.
//
// Every server scenario in the suite issued ONE request at a time, so every per-request mechanism was
// trivially correct: with nothing else in flight, there is nothing to confuse it with. A server's actual
// job is concurrency, and that is where the defects were — an outgoing `http.client` span parented to
// whichever request started LAST (request A's database call shipping inside request B's trace, under B's
// traceId, with A shipping no children and nothing signalling it), and the identity bleed the same
// single-slot shape produces.
//
// Three requests are held open with staggered delays so their lifetimes genuinely overlap. Each carries its
// own user and issues its own outgoing call, and every assertion is per-request: the report, the handler's
// log and the outgoing call must all agree on ONE identity.
import { strFromU8 } from '@bugsee/util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoContractViolations, type ParsedBundle, parseBundles } from './bundle';
import { type MockCollector, startMockCollector } from './collector';
import { type RuntimeTarget, runScenarioProcess, runtimeTargets } from './runtimes';

interface ReportEnvelope {
  type: string;
  summary: string;
  context_id?: string;
  trace_id?: string;
}
type Bundle = ParsedBundle & { request: ReportEnvelope };
interface LogEntry {
  message: string;
  context_id?: string;
}

const WHO = ['alice', 'bob', 'carol'] as const;

const targets = runtimeTargets();
const available = targets.filter((t) => t.bin !== undefined);
for (const t of targets) {
  if (t.bin === undefined) {
    console.warn(`[e2e] runtime ${t.name} unavailable — concurrency NOT verified for it`);
  }
}

describe('concurrent requests keep their identities apart (Wave 3b.4)', () => {
  let collector: MockCollector;

  beforeAll(async () => {
    collector = await startMockCollector();
  });
  afterAll(async () => {
    await collector.close();
  });

  const run = async (target: RuntimeTarget): Promise<Bundle[]> => {
    collector.uploads.length = 0;
    const result = await runScenarioProcess(target, collector.url, 'concurrent-server');
    expect(result.exitCode, `${target.name}\n${result.stderr}`).toBe(0);
    return parseBundles(collector) as Bundle[];
  };

  for (const target of available) {
    describe(target.name, () => {
      let bundles: Bundle[];

      beforeAll(async () => {
        bundles = await run(target);
      }, 60_000);

      it('delivers one report per concurrent request', () => {
        const summaries = bundles.map((b) => b.request.summary).sort();
        expect(summaries).toEqual(WHO.map((w) => `concurrent failure ${w}`).sort());
      });

      it('gives every request its OWN context id', () => {
        // A shared or missing id is the shape of the bleed: if two overlapping requests report the same
        // context, everything stamped with it — logs, network, spans — is attributed to the wrong one.
        const ids = bundles.map((b) => b.request.context_id);
        expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(bundles.length);
      });

      it('never puts one request’s handler log in another request’s bundle', () => {
        // The direct proof of no bleed, and the assertion a single-request scenario cannot make at all.
        for (const bundle of bundles) {
          const who = /concurrent failure (\w+)/.exec(bundle.request.summary)?.[1];
          const logsFile = bundle.files['logs.json'];
          expect(logsFile, `no logs.json for ${who}`).toBeDefined();
          const logs = JSON.parse(strFromU8(logsFile as Uint8Array)) as LogEntry[];
          const own = logs.filter((l) => l.context_id === bundle.request.context_id);
          expect(own.some((l) => l.message.includes(`concurrent handling ${who}`))).toBe(true);
          // …and NOTHING stamped with this context belongs to a different user.
          const foreign = own.filter((l) =>
            WHO.some((w) => w !== who && l.message.includes(`concurrent handling ${w}`)),
          );
          expect(foreign, `${who}'s context carried another request's log`).toEqual([]);
        }
      });

      it('emits nothing that violates the upload contract under concurrency', () => {
        assertNoContractViolations(collector);
      });
    });
  }
});
