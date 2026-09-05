/**
 * Recovery + LIVE-PATH invariants sweep — an oracle with no policy in it (round 6).
 *
 * ══ Why this file keeps being rewritten ═══════════════════════════════════════════════════════════
 *
 * Each earlier version encoded the policy it was meant to audit, and each certified a round that
 * shipped a data-loss defect:
 *
 *   • round 1's oracle keyed an incident on `reportId ?? 'anon:'+summary`, so a legacy blob and its
 *     own marker's rebuild were TWO incidents — it swept the R2-2 double-report and discarded it;
 *   • round 2's oracle computed `settledOk = ok || permanent` — it ASKED THE SDK whether a deletion
 *     was legitimate, so R3-1 (a 429 classified `permanent`, freeing the blob, the marker, the capture
 *     chunks and the whole subtree) was unrepresentable in it;
 *   • round 4 drove the REAL upload stack over a fake collector, which was right, but judged each
 *     answer against a HAND-TRANSCRIPTION of the same Java table `isRetryableHttpStatus` transcribes.
 *     Round 5 proved that independence was of PROVENANCE, not outcome, and proved three further blind
 *     spots by re-injecting a known defect: `231 cases swept, 0 invariant violations`.
 *
 * ══ Round 6 — what changed ════════════════════════════════════════════════════════════════════════
 *
 *   1. THE ORACLE NO LONGER CLASSIFIES A STATUS AT ALL. The fake collector declares its own INTENT for
 *      every answer it gives (`Answer` / `ANSWERS`), records that intent as it answers (`Answered`),
 *      and then BEHAVES accordingly for the rest of the case: an intent it called `transient` really
 *      does clear, one it called `refuse` really is forever. Every invariant reads the recorded intent.
 *      A shared mis-transcription of the Java is therefore no longer invisible: it shows up as the
 *      collector offering to take bytes the SDK has already thrown away (P4), or as the SDK asking
 *      again for bytes the collector has finally refused (P6). `harnessVerdict` survives only as the
 *      collector's own lookup into its own table, and still imports no SDK predicate.
 *   2. CROSS-LAUNCH. One collector now lives across FOUR launches with per-launch answer boundaries, so
 *      "the same bundle is uploaded again on every launch, forever" — the R2-3/R3-6 class the harness
 *      exists to guard, and the one round 5 proved invisible — is finally expressible (P6, and P3 is
 *      now cumulative rather than per-launch).
 *   3. CAPTURE GENERATIONS ARE OBSERVED. `capture-recovery.ts`'s `removeGeneration` destroys a
 *      session's RECORDING; no earlier version ever looked at one. They are now first-class staged
 *      artifacts, so P1/P2 see them.
 *   4. THE LIVE REPORT PATH IS EXERCISED. Sets L and M boot a real `createClient` with the wiring
 *      `node/src/launch.ts` gives it and call `logException` BEFORE any recovery runs. Every earlier
 *      version only seeded pre-staged artifacts, which is exactly how R5-1 survived five rounds.
 *
 * ══ The invariants ════════════════════════════════════════════════════════════════════════════════
 *
 *   P1  NO LOSS         every staged incident is delivered, or explicitly refused by the harness's
 *                       collector, or its bytes are still on disk afterwards.
 *   P2  NO PREMATURE    nothing (blob, marker, capture generation) is deleted that was not first
 *       DELETION        delivered or refused BY ITS OWN BYTES.
 *   P3  AT MOST ONCE    no incident is DELIVERED twice — cumulatively, across every launch — except
 *                       where the case declares it expected (recorded and printed, never hidden).
 *   P4  EVENTUAL        what the collector says it will take, it must end up taking. Catches both
 *       DELIVERY        "kept forever, never retried" and "classified permanent and deleted".
 *   P5  DRAINS IN ONE   with an accepting collector and a pipeline that regains capacity, ONE launch
 *       LAUNCH          delivers every staged bundle. Catches a blob wedged out of the pump.
 *   P6  A FINAL ANSWER  once the collector has ACCEPTED or REFUSED an artifact's bytes, those bytes are
 *       IS FINAL        never sent again in a LATER launch. (Within one launch a re-send is legitimate:
 *                       the retry loop, and the 403 signed-url renew.)
 *   P7  STAYS ALIVE     a failure the collector said would clear must not permanently disable capture.
 *
 * ══ Coverage ══════════════════════════════════════════════════════════════════════════════════════
 *
 *   A  node dead-subtree matrix (markers × blobs × collector answer), two passes
 *   B  node + INJECTED bundleStore, real launch wiring, 1–2 dead subtrees
 *   C  concurrent node recoverers over one dataDir
 *   D  a throwing BundleStore
 *   E  a subtree whose `owner.json` READ THROWS  (P4)                              ← R3-2
 *   F  QUEUE_OVERFLOW_CODE: a real capacity-refusing pipeline (P5)                 ← R3-5
 *   G  per-blob outcomes inside ONE case (blob 1 delivers, blob 2 does not)
 *   H  the browser/worker path: fake IndexedDB, Web Locks, `recoverSiblingBundleQueue`,
 *      `whenReady`, concurrent `Promise.all` siblings                              ← round 3 blind spot
 *   I  CROSS-LAUNCH: one collector, four launches, per-launch answer boundaries (P6) ← R5-5
 *   L  the LIVE report path: a real Client + `logException`, then recovery (P1/P2)  ← R5-1
 *   M  the CONTROL PLANE: a failing /v2/sessions or /v2/issues, incl. the collector's
 *      own error-code namespace inside an HTTP 200 envelope (P6/P7)                ← R5-2, R5-3
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from THIS file, never hardcoded. An absolute path pinned to one checkout would run only on
// its author's machine, and — worse — would silently resolve to the MAIN tree when the harness is run
// from a git worktree, which is the isolation this repo prescribes for agents that inject mutations
// (docs/review/OPEN-FINDINGS.md). It would then certify code that is not the code under test.
const R = fileURLToPath(new URL('../..', import.meta.url));
const { recoverInstances } = await import(`${R}/node/src/recover-instances`);
const core: any = await import(`${R}/core/src/index`);
const nu: any = await import(`${R}/node-utils/src/index`);
const bu: any = await import(`${R}/browser-utils/src/index`);
const u: any = await import(`${R}/util/src/index`);
const fidb: any = await import(`${R}/browser-utils/node_modules/fake-indexeddb/build/esm/index.js`);

const env = {
  platform: { type: 'node', version: '1' },
  runtime: { type: 'node', version: '' },
  sdk: { version: '0', type: 'javascript' },
};
const clock = { wallNow: () => 1_700_000_000_000, monotonicNow: () => 0 };
const ctx = () => ({ appToken: 'tok', environment: env, clock, fileName: () => 'b.zip' });

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH — the harness's own opinion of an HTTP answer. NEVER import the SDK's classifier here.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

type Verdict = 'accept' | 'refuse' | 'transient';

/**
 * The collector's DECLARED INTENT for one answer — the harness's ground truth, and the round-6
 * replacement for the hand-transcribed status table.
 *
 * Round 5's finding was that the old `harnessVerdict` was independent of the SDK only by PROVENANCE:
 * it was a longhand re-typing of the same Java table `isRetryableHttpStatus` transcribes, so a shared
 * mis-reading of the Java was undetectable by construction. A second transcription cannot audit a
 * first one.
 *
 * So the oracle no longer classifies a status at all. Each answer the fake collector may give carries
 * the collector's OWN INTENT, and the collector then BEHAVES that way over the whole sweep:
 *
 *   accept    — these bytes are taken. This attempt and every future one answers 2xx.
 *   refuse    — these bytes are rejected for good. Every future attempt answers the SAME status.
 *   transient — this attempt did not complete. A LATER launch's attempt WILL be accepted.
 *
 * That makes the invariants behavioural rather than table-driven: `transient` is proven by the
 * collector later accepting the same bytes (so deleting them was a loss — P4 fires), and `refuse` is
 * proven by the collector refusing them again (so keeping them is a self-DoS — P6 fires). Neither
 * check consults a status anywhere. The status is only what goes on the wire.
 */
interface Answer {
  readonly status: number;
  readonly intent: Verdict;
  /** Why the collector means that — stated from the protocol, not from the SDK. */
  readonly why: string;
}

/**
 * The eleven answers the sweep drives, and what the collector MEANS by each. Chosen from HTTP
 * semantics and from what a signed-URL object store actually does — deliberately NOT read off
 * `isRetryableHttpStatus`, and deliberately not a second copy of Android's table.
 */
const ANSWERS: readonly Answer[] = [
  { status: 200, intent: 'accept', why: 'the object store stored the bytes' },
  {
    status: 400,
    intent: 'refuse',
    why: 'the payload itself is malformed; re-sending it changes nothing',
  },
  { status: 401, intent: 'transient', why: 'credentials expired — a fresh session mints new ones' },
  // NOT a refusal of the BYTES: a signed PUT 403 is the URL's signature having expired or been
  // scoped wrong, and the SDK can mint a fresh URL for the same object. Round 5 flagged the old
  // table's `refuse` here as its fifth blind spot — it made "delete on the first 403" sweep clean
  // across all 33 403 cases.
  {
    status: 403,
    intent: 'transient',
    why: 'the signed URL was refused, not the payload; a renewed URL works',
  },
  {
    status: 404,
    intent: 'refuse',
    why: 'the target does not exist; re-sending it changes nothing',
  },
  {
    status: 408,
    intent: 'transient',
    why: 'the request timed out in flight; it never reached a decision',
  },
  { status: 425, intent: 'transient', why: 'too early — the server asked to be asked again' },
  { status: 429, intent: 'transient', why: 'rate-limited; the budget refills' },
  { status: 500, intent: 'transient', why: 'the server broke while handling it; it never decided' },
  { status: 503, intent: 'transient', why: 'the server is unavailable; it never decided' },
  {
    status: 0,
    intent: 'transient',
    why: 'the transport threw — DNS/TLS/socket; nothing was decided',
  },
];

const INTENT = new Map(ANSWERS.map((a) => [a.status, a.intent]));

/**
 * What the collector MEANT by the answer it gave. A pure lookup into {@link ANSWERS}; there is no
 * status arithmetic here and no SDK predicate, by construction.
 */
function harnessVerdict(status: number): Verdict {
  const intent = INTENT.get(status);
  if (intent === undefined) throw new Error(`the harness never declared an intent for ${status}`);
  return intent;
}

/** `0` is the harness's code for "the transport threw" (DNS/TLS/socket) — never a refusal. */
const NETWORK_ERROR = 0;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE FAKE COLLECTOR — a real HttpTransport. Every PUT is attributed to the bundle that produced it.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ONE answer the collector gave about ONE incident's bytes, and what it MEANT by it.
 *
 * `verdict` is recorded by the collector as it answers — it is the collector's own intent, not
 * something the oracle derives afterwards from a status. That is what makes the judging below
 * status-blind: no invariant in this file classifies an HTTP code.
 */
interface Answered {
  summary: string;
  status: number;
  verdict: Verdict;
  /** Which call carried the answer — the signed PUT, or the control plane that gates it. */
  via: 'put' | 'issue' | 'session';
  /**
   * The bundle bytes the collector actually received, on an accepted PUT.
   *
   * Every structural invariant here asks WHETHER a report was delivered; none of them asked what was
   * IN it. Making every recovered report ship an empty capture swept clean at 0 violations across 350
   * cases — and "the report arrived, the session is empty" is the failure a user actually notices.
   */
  body?: Uint8Array;
}

/** A control-plane answer a case wants the collector to give instead of the happy path. */
type ControlAnswer = { status: number; body: unknown; verdict: Verdict } | undefined;

interface ControlPlane {
  /** Answer POST /v2/sessions with this instead of granting a token. */
  session?: () => ControlAnswer;
  /** Answer POST /v2/issues with this instead of granting a signed url. */
  issue?: (summary: string) => ControlAnswer;
  /** Whose bytes a SESSION-level answer is about (a control-plane case runs one incident). */
  about?: string;
}

interface Collector {
  transport: (url: string, options?: any) => Promise<any>;
  /** Every answer the collector gave about a bundle — PUT and control plane alike. */
  puts: Answered[];
}

/** `statusFor(summary, attemptIndex)` decides each PUT's answer; `NETWORK_ERROR` makes it throw. */
function collector(
  statusFor: (summary: string, attempt: number) => number,
  control?: ControlPlane,
): Collector {
  const puts: Answered[] = [];
  const bySummary = new Map<string, number>();
  const endpointSummary = new Map<string, string>();
  let n = 0;
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  const transport = async (url: string, options?: any): Promise<any> => {
    if (url.endsWith('/v2/sessions')) {
      const answer = control?.session?.();
      if (answer !== undefined) {
        // A control-plane refusal is a refusal of the BYTES it gates: the SDK cannot upload this
        // incident while the collector answers this way, so the incident's fate is decided here.
        puts.push({
          summary: control?.about ?? '?',
          status: answer.status,
          verdict: answer.verdict,
          via: 'session',
        });
        return { status: answer.status, headers: {}, body: json(answer.body) };
      }
      return { status: 200, headers: {}, body: json({ ok: true, result: { access_token: 'tk' } }) };
    }
    if (url.endsWith('/v2/issues')) {
      const summary = String(JSON.parse(String(options.body)).summary);
      const answer = control?.issue?.(summary);
      if (answer !== undefined) {
        puts.push({ summary, status: answer.status, verdict: answer.verdict, via: 'issue' });
        return { status: answer.status, headers: {}, body: json(answer.body) };
      }
      n += 1;
      const endpoint = `https://s3.test/put/${n}`;
      endpointSummary.set(endpoint, summary);
      return {
        status: 200,
        headers: {},
        body: json({ ok: true, result: { endpoint, issue_id: `i${n}`, recording_id: `r${n}` } }),
      };
    }
    const summary = endpointSummary.get(url) ?? '?';
    const attempt = bySummary.get(summary) ?? 0;
    bySummary.set(summary, attempt + 1);
    const status = statusFor(summary, attempt);
    puts.push({
      summary,
      status,
      verdict: harnessVerdict(status),
      via: 'put',
      // Kept only for an ACCEPTED delivery: that is the one the payload invariant judges, and holding
      // every rejected attempt's bytes would grow with the retry ladder for nothing.
      ...(harnessVerdict(status) === 'accept' ? { body: options?.body as Uint8Array } : {}),
    });
    if (status === NETWORK_ERROR) throw new Error('ECONNRESET');
    return { status, headers: {}, body: new Uint8Array() };
  };
  return { transport, puts };
}

/** The REAL pipeline: api + uploader + orchestrator, with the sleeps removed so a sweep is fast. */
function realPipeline(c: Collector, over: { bufferSize?: number; maxWaiting?: number } = {}) {
  const api = core.createBugseeApi(c.transport, {
    baseUrl: 'https://api.test',
    appToken: 'tok',
    sdkVersion: '0',
  });
  return core.createUploadPipeline({
    api,
    uploader: core.createBundleUploader(c.transport),
    sleep: () => Promise.resolve(),
    computeDelay: () => 0,
    sha256: () => Promise.resolve('00'),
    ...over,
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// OBSERVATION + ORACLE
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** A staged artifact the harness itself created, and the incident it belongs to. Ground truth. */
interface Staged {
  /** `${sub}/${key}` for a blob, `${sub}!${id}` for a marker. */
  readonly slot: string;
  readonly incident: string;
  /** The `request.summary` the SDK will send for THIS artifact's own bytes (blobs only). */
  readonly ownSummary?: string;
}

interface Observation {
  label: string;
  staged: Staged[];
  /** `summary` → incident, for every summary the harness can attribute. */
  incidentOf: (summary: string) => string | undefined;
  puts: Answered[];
  /** Slots still present after the pass. */
  left: Set<string>;
  /** Incidents this case KNOWINGLY double-delivers (R2-2 legacy frames, unclaimed concurrent node). */
  expectedDuplicates?: Set<string>;
}

/** What the live sets log BEFORE the crash — the capture a delivered report must actually carry. */
const PRE_CRASH_LOG = 'something happened just before the crash';

/**
 * The log messages inside an accepted bundle; `undefined` when the bytes are unreadable.
 *
 * P8 exists because every other invariant here judges DELIVERY and none judged CONTENT: making every
 * recovered report ship an empty capture swept clean at 0 violations across all 350 cases. A report
 * that arrives with an empty session is the failure a user actually notices, and it is also what a
 * swept recording looks like from the outside — the marker survives, the rebuild finds no chunks, and
 * an empty bundle is delivered and accepted.
 */
const bundleLogMessages = (body: Uint8Array | undefined): string[] | undefined => {
  if (body === undefined) {
    return undefined;
  }
  try {
    const files = u.unzipSync(body);
    const logs = files['logs.json'];
    if (logs === undefined) {
      return [];
    }
    return (JSON.parse(u.strFromU8(logs)) as Array<{ message?: unknown }>).map((e) =>
      String(e.message ?? ''),
    );
  } catch {
    return undefined;
  }
};

/**
 * P8 — every ACCEPTED delivery of a live incident carries the capture that preceded it.
 *
 * Applied to the LIVE sets only (L and M), and deliberately: those are the ones where a real client
 * produced a real bundle, so the content is the SDK's work. The pre-staged sets carry frames this
 * harness built itself, and asserting on those would only re-read the harness's own fixture.
 *
 * Measured: with the sweep that destroys still-pending recordings injected, set L goes from reporting
 * NOTHING to eight P8 violations — that injection was previously caught only in the single-launch sets,
 * because a marker that survives its swept recording rebuilds an EMPTY bundle which is then delivered
 * and accepted, satisfying every structural invariant here.
 */
function judgePayload(label: string, puts: Answered[]): void {
  for (const put of puts) {
    if (put.verdict !== 'accept' || put.via !== 'put') {
      continue;
    }
    const messages = bundleLogMessages(put.body);
    if (messages === undefined) {
      failures.push(`${label} :: P8 an ACCEPTED bundle could not be read as a bundle at all`);
      continue;
    }
    if (!messages.includes(PRE_CRASH_LOG)) {
      failures.push(
        `${label} :: P8 an ACCEPTED bundle carries NO pre-crash capture — the report arrived EMPTY :: ${JSON.stringify(messages)}`,
      );
    }
  }
}

let cases = 0;
const failures: string[] = [];
const notes: string[] = [];

function judge(o: Observation): void {
  const problems: string[] = [];
  const delivered = new Map<string, number>(); // incident → accepted uploads
  const refusedSummary = new Set<string>();
  const acceptedSummary = new Set<string>();
  for (const put of o.puts) {
    const verdict = put.verdict;
    if (verdict === 'accept') {
      acceptedSummary.add(put.summary);
      const inc = o.incidentOf(put.summary);
      if (inc !== undefined) delivered.set(inc, (delivered.get(inc) ?? 0) + 1);
    } else if (verdict === 'refuse') {
      refusedSummary.add(put.summary);
    }
  }
  const settledIncidents = new Set<string>();
  for (const put of o.puts) {
    if (put.verdict === 'accept' || put.verdict === 'refuse') {
      const inc = o.incidentOf(put.summary);
      if (inc !== undefined) settledIncidents.add(inc);
    }
  }

  // P1 — every staged incident is delivered, refused, or still on disk.
  for (const incident of new Set(o.staged.map((s) => s.incident))) {
    const stillOnDisk = o.staged.some((s) => s.incident === incident && o.left.has(s.slot));
    if (!settledIncidents.has(incident) && !stillOnDisk) {
      problems.push(`P1 incident ${incident} is GONE and the collector never took or refused it`);
    }
  }

  // P2 — nothing is deleted that was not first delivered or refused BY ITS OWN BYTES.
  //
  // "its own bytes" is the load-bearing half: a marker may only be retired once the blob carrying
  // THAT incident settled, and a blob only once the collector answered for THAT blob's summary.
  for (const s of o.staged) {
    if (o.left.has(s.slot)) continue;
    const own = s.ownSummary;
    const settled =
      own !== undefined
        ? acceptedSummary.has(own) || refusedSummary.has(own)
        : settledIncidents.has(s.incident);
    if (!settled) {
      problems.push(`P2 ${s.slot} (incident ${s.incident}) was DELETED without a settled upload`);
    }
  }

  // P3 — at most one DELIVERY per incident.
  for (const [incident, n] of delivered) {
    if (n <= 1) continue;
    if (o.expectedDuplicates?.has(incident) === true) {
      notes.push(
        `${o.label}: incident ${incident} delivered ${n}x — declared expected by the case`,
      );
      continue;
    }
    problems.push(`P3 incident ${incident} DELIVERED ${n}x`);
  }

  if (problems.length > 0) {
    failures.push(
      `${o.label} :: ${problems.join(' | ')} :: ${JSON.stringify({
        puts: o.puts,
        left: [...o.left],
      })}`,
    );
  }
}

/**
 * P6 — NO RE-OFFER AFTER A FINAL ANSWER, and P3/P4 across a SEQUENCE of launches.
 *
 * Round 5's first two blind spots, closed together. The old sweep judged one launch at a time and
 * counted a delivery only for a 2xx, so:
 *
 *   • "at most once" was inert in ten of the eleven status columns (no 2xx, no delivery to count), and
 *   • "uploaded AGAIN on every launch" — the R2-3/R3-6 class the whole harness exists to guard — was
 *     not expressible at all. Re-injecting it gave 0 violations across 231 cases.
 *
 * The collector here lives for the WHOLE case and behaves as its declared intent says (see `Answer`),
 * so the oracle needs no status table:
 *
 *   P6  once the collector has ACCEPTED or REFUSED a given artifact's bytes, those bytes must never be
 *       PUT again in a LATER launch. Within one launch a re-PUT is legitimate (the retry loop, and the
 *       403 signed-url renew), so the scope is strictly cross-launch.
 *   P3  cumulative across every launch, not per launch.
 *   P4  an intent the collector said would clear MUST end in delivery by the last launch — which is how
 *       "classified permanent and deleted" is caught without asking anything what `permanent` means.
 */
function judgeCrossLaunch(o: {
  label: string;
  staged: Staged[];
  incidentOf: (summary: string) => string | undefined;
  perLaunch: Answered[][];
  left: Set<string>;
  /** Does the collector promise to take these bytes by the end? (`refuse` does not.) */
  mustDeliver: boolean;
  expectedDuplicates?: Set<string>;
}): void {
  const flat = o.perLaunch.flat();
  judge({
    label: o.label,
    staged: o.staged,
    incidentOf: o.incidentOf,
    puts: flat,
    left: o.left,
    ...(o.expectedDuplicates !== undefined ? { expectedDuplicates: o.expectedDuplicates } : {}),
  });

  // P6 — a final answer is final.
  const finalAnswerAt = new Map<string, number>();
  const problems: string[] = [];
  o.perLaunch.forEach((puts, index) => {
    for (const put of puts) {
      const settledAt = finalAnswerAt.get(put.summary);
      if (settledAt !== undefined && settledAt < index) {
        problems.push(
          `P6 ${put.summary} was PUT again in launch ${index + 1} after the collector answered it FINALLY in launch ${settledAt + 1}`,
        );
      }
    }
    for (const put of puts) {
      const verdict = put.verdict;
      if ((verdict === 'accept' || verdict === 'refuse') && !finalAnswerAt.has(put.summary)) {
        finalAnswerAt.set(put.summary, index);
      }
    }
  });

  // WHY THERE IS NO ORDERED VARIANT OF P2 HERE.
  //
  // A review round found that `judge` above sees the FLATTENED put log and the FINAL disk state, and
  // concluded that "a deletion in launch 2 is licensed by an accept in launch 4". An ordered check was
  // built for it, and then measured: with no refinement it fired 15 times on CLEAN code (a recording
  // dropped once its bundle was staged is correct housekeeping, not a loss — the bundle already embeds
  // the capture), and once refined to allow that it caught nothing any other invariant did not. Against
  // a premature-blob-release mutation it produced 15 findings and **0** that were not already reported
  // by P1/P2/P3/P4 on the same case.
  //
  // The reason is structural: you cannot settle bytes you have already deleted, so "deleted, then
  // settled later" is unreachable for one artifact. Across artifacts of the same incident it IS
  // reachable — a marker retired while its blob still carries the incident — but that is exactly what
  // `UploadResult.retained` licenses, so it is correct rather than a defect.
  //
  // The blindness that review actually pointed at is real, but it is not about ordering: a swept
  // recording whose marker survives yields a report that is DELIVERED AND EMPTY, which satisfies every
  // structural invariant here. That is what the payload checks below exist for.

  // P4 — what the collector said it would take, it must have taken.
  if (o.mustDeliver) {
    const ok = new Set(
      flat.filter((put) => put.verdict === 'accept').map((put) => o.incidentOf(put.summary)),
    );
    for (const incident of new Set(o.staged.map((st) => st.incident))) {
      if (!ok.has(incident)) {
        problems.push(
          `P4 incident ${incident} was never delivered, though the collector would take it`,
        );
      }
    }
  }

  if (problems.length > 0) {
    failures.push(
      `${o.label} :: ${[...new Set(problems)].join(' | ')} :: ${JSON.stringify({
        perLaunch: o.perLaunch,
        left: [...o.left],
      })}`,
    );
  }
}

/** P4/P5 — an accepting collector must have delivered every staged incident by the end. */
function judgeEventual(
  label: string,
  staged: Staged[],
  puts: Collector['puts'],
  incidentOf: (summary: string) => string | undefined,
): void {
  const ok = new Set(
    puts
      .filter((p) => p.verdict === 'accept')
      .map((p) => incidentOf(p.summary))
      .filter((i): i is string => i !== undefined),
  );
  const missing = new Set(staged.map((s) => s.incident).filter((i) => !ok.has(i)));
  if (missing.size > 0) {
    failures.push(
      `${label} :: P4/P5 an ALWAYS-ACCEPTING collector never received ${[...missing].join(', ')} :: ${JSON.stringify(puts)}`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// NODE FIXTURES
// ══════════════════════════════════════════════════════════════════════════════════════════════════

type BlobSpec = { key: string; incident: string; withId: boolean };

const blobSummary = (sub: string, key: string) => `blob:${sub}:${key}`;

const frame = (b: BlobSpec, sub: string) =>
  core.serializeBundle({
    request: {
      type: 'crash',
      summary: blobSummary(sub, b.key),
      severity: 3,
      source: { type: 'crash', mechanism: 'uncaught' },
      created_on: '2026-05-29T00:00:00Z',
      environment: env,
    },
    body: new Uint8Array([1, 2, 3]),
    fileName: 'p.zip',
    ...(b.withId ? { reportId: b.incident } : {}),
  });

/**
 * `${sub}~g${generation}` → the incident whose recording that capture generation IS.
 *
 * Round 5's third blind spot: no version of this harness ever looked at capture generations, so
 * `capture-recovery.ts:224`'s `removeGeneration` — the call that destroys a session's RECORDING, the
 * thing the product exists to show — was invisible to P1 and P2. A blob and a marker are two ways to
 * re-send an incident; the generation is the incident's only copy of what happened.
 */
const generationIncident = new Map<string, string>();

/** Every capture generation currently on disk for `sub`, as observation slots. */
const nodeGenerations = (dataDir: string, sub: string): string[] =>
  nu
    .createFsChunkStorage(join(dataDir, sub, 'capture'))
    .generations()
    .map((g: number) => `${sub}~g${g}`);

/** Seed a dead sibling subtree: owner.json + one capture generation and report marker per incident. */
function seedSubtree(dataDir: string, sub: string, markers: string[]): void {
  const root = join(dataDir, sub);
  nu.ensureDir(root);
  nu.writeFileSecure(
    join(root, 'owner.json'),
    JSON.stringify({ instanceId: sub, pid: 999_999, threadId: 0, startedAt: 1, version: '0' }),
  );
  const markerStore = nu.createNodeReportMarkerStore(join(root, 'incidents'));
  markers.forEach((id, i) => {
    const gen = 500 + i;
    generationIncident.set(`${sub}~g${gen}`, id);
    const b = core.createFileChunkBackend(nu.createFsChunkStorage(join(root, 'capture')), {
      generation: gen,
      cleanOtherGenerations: false,
    });
    b.openPart({ generation: gen, number: 0 }, gen);
    b.appendEntry(
      { generation: gen, number: 0 },
      { type: 'log', timestamp: 1, serialized: JSON.stringify({ timestamp: 1, data: id }) },
    );
    b.closePart({ generation: gen, number: 0 }, gen + 100, 0);
    markerStore.put({
      generation: gen,
      request: core.createReportingRequest({
        source: { type: 'crash' },
        id,
        summary: markerSummary(id),
      }),
      attributes: {},
      userIdentifier: null,
    });
  });
}

/** A marker-leg rebuild carries the incident id as `reportId`; the harness reads it back off the summary. */
const markerSummary = (id: string) => `Report ${id}`;

const readNodeState = (dataDir: string, subs: string[]): Set<string> => {
  const left = new Set<string>();
  for (const sub of subs) {
    for (const k of nu.createNodeBundleStore(join(dataDir, sub, 'pending')).list()) {
      left.add(`${sub}/${k}`);
    }
    for (const m of nu.createNodeReportMarkerStore(join(dataDir, sub, 'incidents')).list()) {
      left.add(`${sub}!${m.request.id}`);
    }
    // The RECORDING. Observed since round 6 — see `generationIncident`.
    for (const g of nodeGenerations(dataDir, sub)) {
      left.add(g);
    }
  }
  return left;
};

/** Turn the generation slots present in `before` into staged artifacts of their own incidents. */
const stagedGenerations = (before: Iterable<string>): Staged[] =>
  [...before]
    .filter((slot) => slot.includes('~g'))
    .flatMap((slot) => {
      const incident = generationIncident.get(slot);
      return incident === undefined ? [] : [{ slot, incident }];
    });

/** Attribute a PUT to an incident: `blob:<sub>:<key>` from the case, else a marker rebuild. */
function attributor(placed: Array<BlobSpec & { sub: string }>) {
  return (summary: string): string | undefined => {
    const m = /^blob:([^:]+):(.+)$/.exec(summary);
    if (m !== null) return placed.find((b) => b.sub === m[1] && b.key === m[2])?.incident;
    const r = /^Report (.+)$/.exec(summary);
    return r !== null ? r[1] : undefined;
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// ══ A. node dead-subtree matrix ════════════════════════════════════════════════════════════════════

const blobSets: BlobSpec[][] = [
  [],
  [{ key: 'bA', incident: 'A', withId: true }],
  [{ key: 'bB', incident: 'B', withId: true }],
  [{ key: 'bL', incident: 'A', withId: false }], // LEGACY frame (no id) for incident A
  [
    { key: 'bA', incident: 'A', withId: true },
    { key: 'bB', incident: 'B', withId: true },
  ],
  [
    { key: 'bA', incident: 'A', withId: true },
    { key: 'bL', incident: 'A', withId: false },
  ],
  [
    { key: 'bB', incident: 'B', withId: true },
    { key: 'bL', incident: 'A', withId: false },
  ],
];
const markerSets = [[], ['A'], ['A', 'C']];
// Every class the classifier must separate, plus a thrown transport.
const statuses = [200, 400, 401, 403, 404, 408, 425, 429, 500, 503, NETWORK_ERROR];

for (const markers of markerSets)
  for (const blobs of blobSets)
    for (const status of statuses) {
      cases += 1;
      const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-a-'));
      const sub = '9-9-dead';
      seedSubtree(dir, sub, markers);
      const store = nu.createNodeBundleStore(join(dir, sub, 'pending'));
      for (const b of blobs) store.put(b.key, frame(b, sub));

      const placed = blobs.map((b) => ({ ...b, sub }));
      const incidentOf = attributor(placed);
      // A LEGACY blob (no id in the frame) cannot be tied to its marker by anything in the SDK — the
      // documented, accepted R2-2 trade-off. Declared here so P3 records it instead of failing.
      const expectedDuplicates = new Set(placed.filter((b) => !b.withId).map((b) => b.incident));
      const label = `A ${JSON.stringify({ markers, blobs: blobs.map((b) => b.key), status })}`;

      for (const pass of [1, 2]) {
        const before = readNodeState(dir, [sub]);
        const staged: Staged[] = [
          ...placed
            .filter((b) => before.has(`${b.sub}/${b.key}`))
            .map((b) => ({
              slot: `${b.sub}/${b.key}`,
              incident: b.incident,
              ownSummary: blobSummary(b.sub, b.key),
            })),
          // A MARKER carries no `ownSummary`: it is one of two copies of a single incident, so it is
          // legitimately retired once that INCIDENT settled — through its blob or through its own
          // rebuild. Requiring its own bytes would flag the reconciliation the design exists for.
          ...[...before]
            .filter((s) => s.includes('!'))
            .map((s) => ({ slot: s, incident: s.slice(s.indexOf('!') + 1) })),
          ...stagedGenerations(before),
        ];
        const c = collector(() => status);
        await recoverInstances({
          dataDir: dir,
          ownInstanceId: `1-0-live${pass}`,
          uploadPipeline: realPipeline(c),
          context: ctx,
          onError: () => {},
        });
        await settle();
        judge({
          label: `${label} pass${pass}`,
          staged,
          incidentOf,
          puts: c.puts,
          left: readNodeState(dir, [sub]),
          expectedDuplicates,
        });
      }
      rmSync(dir, { recursive: true, force: true });
    }

// ══ B. node + INJECTED bundleStore, real launch wiring ══════════════════════════════════════════════

for (const subs of [['9-9-deadA'], ['9-9-deadA', '9-9-deadB']])
  for (const status of [200, 429, 400, 503])
    for (const legacy of [false, true]) {
      cases += 1;
      const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-b-'));
      const shared = join(dir, 'shared-pending');
      const placed: Array<BlobSpec & { sub: string }> = [];
      subs.forEach((sub, i) => {
        const id = `INC${i}`;
        seedSubtree(dir, sub, [id]);
        placed.push({ key: `s${i}`, incident: id, withId: !legacy, sub });
      });
      const sharedStore = nu.createNodeBundleStore(shared);
      for (const b of placed) sharedStore.put(b.key, frame(b, b.sub));

      const staged: Staged[] = [
        ...placed.map((b) => ({
          slot: `${b.sub}/${b.key}`,
          incident: b.incident,
          ownSummary: blobSummary(b.sub, b.key),
        })),
        ...subs.map((sub, i) => ({ slot: `${sub}!INC${i}`, incident: `INC${i}` })),
        ...stagedGenerations(readNodeState(dir, subs)),
      ];
      const c = collector(() => status);
      const base = realPipeline(c);
      const durable = core.createDurableUploadPipeline({
        store: nu.createNodeBundleStore(shared),
        pipeline: base,
      });

      // …exactly node/launch.ts's wiring with options.bundleStore set.
      await recoverInstances({
        dataDir: dir,
        ownInstanceId: '1-0-live',
        uploadPipeline: durable,
        context: ctx,
        onError: () => {},
        reconcileOwnQueue: async (ms: any) => {
          const replay = core.createMarkerAwareBundleReplay({ markers: ms, pipeline: base });
          durable.recover({
            via: replay.pipeline,
            select: (b: any) => b.reportId !== undefined && replay.pendingReportIds.has(b.reportId),
          });
          return replay.skipReportIds;
        },
      });
      durable.recover();
      await settle();

      const left = readNodeState(dir, subs);
      for (const k of sharedStore.list()) {
        const b = placed.find((p) => p.key === k);
        left.add(b !== undefined ? `${b.sub}/${b.key}` : `?/${k}`);
      }
      judge({
        label: `B ${JSON.stringify({ subs, status, legacy })}`,
        staged,
        incidentOf: attributor(placed),
        puts: c.puts,
        left,
        expectedDuplicates: new Set(legacy ? placed.map((b) => b.incident) : []),
      });
      rmSync(dir, { recursive: true, force: true });
    }

// ══ C. concurrent node recoverers over one dataDir ═════════════════════════════════════════════════

for (const status of [200, 429, 400]) {
  cases += 1;
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-c-'));
  const sub = '9-9-dead';
  seedSubtree(dir, sub, ['A']);
  const placed = [{ key: 'bA', incident: 'A', withId: true, sub }];
  nu.createNodeBundleStore(join(dir, sub, 'pending')).put('bA', frame(placed[0]!, sub));
  const c = collector(() => status);
  await Promise.all(
    [0, 1].map((n) =>
      recoverInstances({
        dataDir: dir,
        ownInstanceId: `1-0-live${n}`,
        uploadPipeline: realPipeline(c),
        context: ctx,
        onError: () => {},
      }),
    ),
  );
  await settle();
  judge({
    label: `C ${status}`,
    staged: [
      { slot: `${sub}/bA`, incident: 'A', ownSummary: blobSummary(sub, 'bA') },
      { slot: `${sub}!A`, incident: 'A' },
      ...stagedGenerations([`${sub}~g500`]),
    ],
    incidentOf: attributor(placed),
    puts: c.puts,
    left: readNodeState(dir, [sub]),
    // KNOWN-OPEN: node has no atomic-rename claim, so two simultaneous launches both recover the
    // same subtree. Declared, printed, not asserted away (recover-instances.ts:38).
    expectedDuplicates: new Set(['A']),
  });
  rmSync(dir, { recursive: true, force: true });
}

// ══ D. a throwing BundleStore must never throw into launch ═════════════════════════════════════════

{
  cases += 1;
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-d-'));
  seedSubtree(dir, '9-9-dead', ['A']);
  const boom = () => {
    throw new Error('store exploded');
  };
  const c = collector(() => 200);
  const durable = core.createDurableUploadPipeline({
    store: { put: boom, list: boom, read: boom, remove: boom },
    pipeline: realPipeline(c),
    onError: () => {},
  });
  let threw: unknown;
  try {
    durable.recover();
    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: durable,
      context: ctx,
      onError: () => {},
    });
  } catch (e) {
    threw = e;
  }
  await settle();
  if (threw !== undefined)
    failures.push(`D throwing store: recovery threw into launch: ${String(threw)}`);
  rmSync(dir, { recursive: true, force: true });
}

// ══ E. an unreadable `owner.json` — the liveness probe THROWS (R3-2) ═══════════════════════════════
//
// `readOwner` → `readFileBytes` re-throws any non-ENOENT errno and sits OUTSIDE every try in
// `recoverInstances`'s loop. A directory where the file should be is an EISDIR that reproduces an
// EACCES (root-written subtree, dropped-privilege peer) without needing privileges to set up.
//
// Judged by P4: the collector accepts EVERYTHING, and the harness runs THREE launches. A blob that is
// still on disk after three accepting launches has not been "kept safe", it has been abandoned.

for (const shape of ['injected-store', 'per-instance-store', 'scan-always-rejects'] as const) {
  cases += 1;
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-e-'));
  const good = '9-9-deadGOOD';
  const bad = '9-9-deadBAD';
  seedSubtree(dir, good, ['GOOD']);
  seedSubtree(dir, bad, ['BAD']);
  rmSync(join(dir, bad, 'owner.json'));
  mkdirSync(join(dir, bad, 'owner.json')); // a DIRECTORY → readFileBytes throws EISDIR

  const shared = join(dir, 'shared-pending');
  const placed = [{ key: 'sg', incident: 'GOOD', withId: true, sub: good }];
  const injected = shape !== 'per-instance-store';
  const store = nu.createNodeBundleStore(injected ? shared : join(dir, good, 'pending'));
  store.put('sg', frame(placed[0]!, good));

  const staged: Staged[] = [
    { slot: `${good}/sg`, incident: 'GOOD', ownSummary: blobSummary(good, 'sg') },
  ];
  const c = collector(() => 200);
  for (const launch of [1, 2, 3]) {
    const base = realPipeline(c);
    const durable = core.createDurableUploadPipeline({
      store: nu.createNodeBundleStore(injected ? shared : join(dir, good, 'pending')),
      pipeline: base,
    });
    // …the EXACT wiring node/src/launch.ts now uses. The launches call it as `void
    // runLaunchRecovery({…})`, so a rejection would be an UNHANDLED rejection out of launch() — on node
    // a process-level event the host may treat as fatal, in the browser something the SDK's own
    // `unhandledrejection` listener reports to the collector as the application's crash.
    const recovery = core.runLaunchRecovery({
      queue: durable,
      shared: injected,
      pipeline: base,
      onError: () => {},
      scan: (reconcileOwnQueue?: any) =>
        shape === 'scan-always-rejects'
          ? Promise.reject(new Error('the scan blew up'))
          : recoverInstances({
              dataDir: dir,
              ownInstanceId: `1-0-live${launch}`,
              uploadPipeline: durable,
              context: ctx,
              onError: () => {},
              ...(reconcileOwnQueue !== undefined ? { reconcileOwnQueue } : {}),
            }),
    });
    try {
      await recovery;
    } catch (error) {
      failures.push(`E ${shape} :: runLaunchRecovery REJECTED into launch(): ${String(error)}`);
    }
    await settle();
  }
  judgeEventual(`E ${shape} (unreadable owner.json)`, staged, c.puts, attributor(placed));
  rmSync(dir, { recursive: true, force: true });
}

// ══ F. QUEUE_OVERFLOW_CODE against a real capacity-refusing pipeline (R3-5) ════════════════════════
//
// `bufferSize:1, maxWaiting:0` makes the REAL pipeline answer `queue_overflow` to anything arriving
// while an upload is in flight — the condition the durable pump exists to recover from. Judged by P5:
// the collector accepts everything and capacity always comes back, so ONE launch must drain the queue.

for (const selective of [false, true]) {
  cases += 1;
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-f-'));
  const sub = '9-9-dead';
  seedSubtree(dir, sub, ['SEL']);
  const shared = join(dir, 'shared-pending');
  const store = nu.createNodeBundleStore(shared);
  // `f1` is the dead sibling's own incident (a selective pass takes it); `f2`/`f3` belong to nobody,
  // so a selective pass DEFERS them and only the unfiltered pass may hand them over.
  const placed = [
    { key: 'f1', incident: 'SEL', withId: true, sub },
    { key: 'f2', incident: 'OTH2', withId: true, sub },
    { key: 'f3', incident: 'OTH3', withId: true, sub },
  ];
  for (const b of placed) store.put(b.key, frame(b, sub));

  const c = collector(() => 200);
  const base = realPipeline(c, { bufferSize: 1, maxWaiting: 0 });
  const durable = core.createDurableUploadPipeline({
    store: nu.createNodeBundleStore(shared),
    pipeline: base,
  });

  await recoverInstances({
    dataDir: dir,
    ownInstanceId: '1-0-live',
    uploadPipeline: durable,
    context: ctx,
    onError: () => {},
    ...(selective
      ? {
          reconcileOwnQueue: async (ms: any) => {
            const replay = core.createMarkerAwareBundleReplay({ markers: ms, pipeline: base });
            durable.recover({
              via: replay.pipeline,
              select: (b: any) =>
                b.reportId !== undefined && replay.pendingReportIds.has(b.reportId),
            });
            return replay.skipReportIds;
          },
        }
      : {}),
  });
  durable.recover();
  await settle();
  await settle();

  judgeEventual(
    `F ${selective ? 'selective+unfiltered passes' : 'unfiltered pass only'} (capacity refusal)`,
    placed.map((b) => ({
      slot: `${b.sub}/${b.key}`,
      incident: b.incident,
      ownSummary: blobSummary(b.sub, b.key),
    })),
    c.puts,
    attributor(placed),
  );
  const stuck = store.list();
  if (stuck.length > 0) {
    failures.push(
      `F ${selective ? 'selective' : 'plain'} :: P5 ${stuck.length} blob(s) still staged after an accepting launch: ${stuck.join(', ')}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

// ══ G. per-blob outcomes inside ONE case ═══════════════════════════════════════════════════════════

for (const [s1, s2] of [
  [200, 500],
  [200, 429],
  [200, 400],
  [429, 200],
  [400, 200],
] as Array<[number, number]>) {
  cases += 1;
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-g-'));
  const sub = '9-9-dead';
  seedSubtree(dir, sub, ['G1', 'G2']);
  const placed = [
    { key: 'g1', incident: 'G1', withId: true, sub },
    { key: 'g2', incident: 'G2', withId: true, sub },
  ];
  const store = nu.createNodeBundleStore(join(dir, sub, 'pending'));
  for (const b of placed) store.put(b.key, frame(b, sub));

  const c = collector((summary) =>
    summary.endsWith('g1') || summary === markerSummary('G1') ? s1 : s2,
  );
  await recoverInstances({
    dataDir: dir,
    ownInstanceId: '1-0-live',
    uploadPipeline: realPipeline(c),
    context: ctx,
    onError: () => {},
  });
  await settle();
  judge({
    label: `G ${s1}/${s2}`,
    staged: [
      { slot: `${sub}/g1`, incident: 'G1', ownSummary: blobSummary(sub, 'g1') },
      { slot: `${sub}/g2`, incident: 'G2', ownSummary: blobSummary(sub, 'g2') },
      { slot: `${sub}!G1`, incident: 'G1' },
      { slot: `${sub}!G2`, incident: 'G2' },
      ...stagedGenerations([`${sub}~g500`, `${sub}~g501`]),
    ],
    incidentOf: attributor(placed),
    puts: c.puts,
    left: readNodeState(dir, [sub]),
  });
  rmSync(dir, { recursive: true, force: true });
}

// ══ H. the BROWSER / WORKER path ═══════════════════════════════════════════════════════════════════
//
// Round 3's harness never touched it at all. This drives the real `createCoexistence` over
// fake-indexeddb with a fake LockManager: dead-sibling discovery, `recoverSiblingBundleQueue`, the
// marker-aware reconciliation, `whenReady` hydration, and TWO dead siblings recovered concurrently
// through the same `Promise.all` the coordinator uses.

const TOK = 'tok';

/** The browser tier's Web Locks fake: a lifetime-held lock means LIVE, an absent one means DEAD. */
function fakeLocks() {
  const heldForever = new Set<string>();
  const inUse = new Set<string>();
  return {
    manager: {
      request(name: string, options: any, callback: any) {
        if (options.ifAvailable) {
          if (heldForever.has(name) || inUse.has(name)) return Promise.resolve(callback(null));
          inUse.add(name);
          return Promise.resolve(callback({ name })).finally(() => inUse.delete(name));
        }
        heldForever.add(name);
        void callback({ name });
        return new Promise<never>(() => {});
      },
    },
    hold: (name: string) => heldForever.add(name),
  };
}

async function seedBrowserSibling(
  idb: any,
  instanceId: string,
  blobs: Array<{ key: string; spec: BlobSpec }>,
  markerIds: string[],
): Promise<void> {
  const bundles = bu.createIdbBlobStore({
    databaseName: bu.coexistenceDatabaseName(TOK),
    indexedDB: idb,
  });
  for (const { key, spec } of blobs) {
    await bundles.put(`${instanceId}/${key}`, frame(spec, instanceId));
  }
  const markers = bu.createIdbBlobStore({
    databaseName: bu.markerDatabaseName(TOK),
    storeName: 'markers',
    indexedDB: idb,
  });
  const capture = bu.createIdbKeyedStore({
    databaseName: bu.captureDatabaseName(TOK),
    storeName: 'capture',
    indexedDB: idb,
  });
  for (const id of markerIds) {
    await markers.put(
      `${instanceId}/${id}`,
      new TextEncoder().encode(
        JSON.stringify({
          generation: 9,
          request: {
            id,
            source: { type: 'crash' },
            report: { id, type: 'crash', severity: 3, summary: markerSummary(id) },
          },
          attributes: {},
          userIdentifier: null,
        }),
      ),
    );
    await capture.put(`${instanceId}/c-${id}`, new Uint8Array([1]));
  }
}

const browserLeft = async (idb: any): Promise<Set<string>> => {
  const left = new Set<string>();
  for (const [k] of await bu
    .createIdbBlobStore({ databaseName: bu.coexistenceDatabaseName(TOK), indexedDB: idb })
    .loadAll()) {
    const split = bu.splitInstanceKey(k);
    if (split !== undefined) left.add(`${split.instanceId}/${split.id}`);
  }
  for (const [k] of await bu
    .createIdbBlobStore({
      databaseName: bu.markerDatabaseName(TOK),
      storeName: 'markers',
      indexedDB: idb,
    })
    .loadAll()) {
    const split = bu.splitInstanceKey(k);
    if (split !== undefined) left.add(`${split.instanceId}!${split.id}`);
  }
  return left;
};

for (const status of statuses)
  for (const siblings of [1, 2]) {
    cases += 1;
    const idb = new fidb.IDBFactory();
    const locks = fakeLocks();
    const subs = siblings === 1 ? ['deadA'] : ['deadA', 'deadB'];
    const placed: Array<BlobSpec & { sub: string }> = [];
    const staged: Staged[] = [];
    for (const [i, sub] of subs.entries()) {
      const incident = `W${i}`;
      const spec = { key: `w${i}`, incident, withId: true };
      placed.push({ ...spec, sub });
      await seedBrowserSibling(idb, sub, [{ key: spec.key, spec: { ...spec } }], [incident]);
      staged.push({
        slot: `${sub}/${spec.key}`,
        incident,
        ownSummary: blobSummary(sub, spec.key),
      });
      staged.push({ slot: `${sub}!${incident}`, incident });
    }
    // A LIVE sibling holding its lock must be left completely alone.
    await seedBrowserSibling(
      idb,
      'liveC',
      [{ key: 'wl', spec: { key: 'wl', incident: 'LIVE', withId: true } }],
      ['LIVE'],
    );
    locks.hold(bu.instanceLockName(TOK, 'liveC'));

    const c = collector(() => status);
    const base = realPipeline(c);
    const coex = bu.createCoexistence({
      appToken: TOK,
      persist: true,
      captureRecovery: true,
      locks: locks.manager,
      indexedDB: idb,
      onError: () => {},
    });
    await coex.recoverDeadSiblings({
      uploadPipeline: base,
      recoverReportsForSibling: async ({ captureView, markers, skipReportIds }: any) => {
        await core.recoverReports({
          backend: bu.createIdbChunkBackend(captureView, {
            generation: -1,
            cleanOtherGenerations: false,
          }),
          currentGeneration: -1,
          markers,
          context: ctx,
          uploadPipeline: base,
          skipReportIds,
          onError: () => {},
        });
      },
    });
    await settle();

    const left = await browserLeft(idb);
    if (!left.has('liveC/wl') || !left.has('liveC!LIVE')) {
      failures.push(`H ${status}/${siblings} :: a LIVE sibling's data was touched :: ${[...left]}`);
    }
    judge({
      label: `H browser ${status} x${siblings}`,
      staged,
      incidentOf: attributor(placed),
      puts: c.puts,
      left,
    });
  }

// ══ I. CROSS-LAUNCH — ONE collector, FOUR launches, per-launch PUT boundaries ══════════════════════
//
// Everything above this point is single-launch (or, in A, two launches with a FRESH collector each),
// which is why "the same bundle is uploaded again on every launch, forever" was unrepresentable. Here
// one collector lives for the whole case and BEHAVES as its intent says, so the SDK is measured
// against what the collector will actually do next rather than against a status table.

const LAUNCHES = 4;
/** After this launch a `transient` condition CLEARS — so P4 can prove "you deleted a recoverable one". */
const CLEARS_AFTER = 2;

for (const answer of ANSWERS)
  for (const shape of ['blob+marker', 'blob-only', 'marker-only'] as const) {
    cases += 1;
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-i-'));
    const sub = '9-9-dead';
    const incident = 'I0';
    const markerIds = shape === 'blob-only' ? [] : [incident];
    seedSubtree(dir, sub, markerIds);
    const placed = shape === 'marker-only' ? [] : [{ key: 'i0', incident, withId: true, sub }];
    const store = nu.createNodeBundleStore(join(dir, sub, 'pending'));
    for (const b of placed) store.put(b.key, frame(b, sub));

    const before = readNodeState(dir, [sub]);
    const staged: Staged[] = [
      ...placed.map((b) => ({
        slot: `${b.sub}/${b.key}`,
        incident: b.incident,
        ownSummary: blobSummary(b.sub, b.key),
      })),
      ...markerIds.map((id) => ({ slot: `${sub}!${id}`, incident: id })),
      ...stagedGenerations(before),
    ];

    let launch = 0;
    const c = collector(() =>
      answer.intent === 'transient' && launch > CLEARS_AFTER ? 200 : answer.status,
    );
    const perLaunch: Answered[][] = [];
    for (launch = 1; launch <= LAUNCHES; launch += 1) {
      const mark = c.puts.length;
      await recoverInstances({
        dataDir: dir,
        ownInstanceId: `1-0-live${launch}`,
        uploadPipeline: realPipeline(c),
        context: ctx,
        onError: () => {},
      });
      await settle();
      perLaunch.push(c.puts.slice(mark));
    }

    judgeCrossLaunch({
      label: `I ${answer.status} (${answer.intent}: ${answer.why}) ${shape}`,
      staged,
      incidentOf: attributor(placed),
      perLaunch,
      left: readNodeState(dir, [sub]),
      mustDeliver: answer.intent !== 'refuse',
    });
    rmSync(dir, { recursive: true, force: true });
  }

// ══ L. THE LIVE REPORT PATH — a real Client, a real logException, then real recovery ═══════════════
//
// Round 5's FOURTH blind spot, and the one that mattered most: every version of this harness seeded
// PRE-STAGED artifacts and ran recovery. Nothing ever went through `client.ts`'s `submitReport` — the
// path a crash actually takes on a running application — which is exactly how R5-1 (the marker retired
// on a RETRYABLE failure) survived five review rounds.
//
// So this set boots a real `createClient` with the wiring `node/src/launch.ts` gives it (a file-backed
// capture store on a real capture generation, a real on-disk report-marker store, a real durable bundle
// queue over a real `BundleStore`), calls `logException`, and only THEN runs the recovery launches. The
// second dimension is the one the durable queue's own `catch` makes reachable: a `BundleStore.put` that
// THROWS (ENOSPC / EROFS / EACCES / EDQUOT, a `RangeError` out of `serializeBundle`, or any integrator
// `options.bundleStore`), which `durable-upload-pipeline.ts:403-407` swallows and continues past — so
// "the durable bundle queue owns delivery from here" is not true of that launch.

const noopScheduler = { setInterval: () => 0, clearInterval: () => {} };

for (const answer of ANSWERS)
  for (const storeMode of ['durable-store-works', 'durable-store-put-THROWS'] as const) {
    cases += 1;
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-l-'));
    const sub = '9-9-dead';
    const root = join(dir, sub);
    nu.ensureDir(root);
    // The subtree is DEAD to every later launch — pid 999999 owns it and is not running.
    nu.writeFileSecure(
      join(root, 'owner.json'),
      JSON.stringify({ instanceId: sub, pid: 999_999, threadId: 0, startedAt: 1, version: '0' }),
    );

    const generation = 900;
    const incident = 'LIVE';
    generationIncident.set(`${sub}~g${generation}`, incident);

    let launch = 1;
    const c = collector(() =>
      answer.intent === 'transient' && launch > CLEARS_AFTER ? 200 : answer.status,
    );
    const perLaunch: Answered[][] = [];

    // ── launch 1: the LIVE path ──────────────────────────────────────────────────────────────────
    const rawMarkers = nu.createNodeReportMarkerStore(join(root, 'incidents'));
    // The marker ids the client MINTED. `submitReport` writes the marker before assembly and retires it
    // on settle, so by the time `logException` resolves there may be nothing left to observe — the
    // whole point of R5-1. Recorded on the way in, never inferred on the way out.
    const mintedMarkerIds: string[] = [];
    const markerStore = {
      list: () => rawMarkers.list(),
      remove: (id: string) => rawMarkers.remove(id),
      put: (marker: any) => {
        mintedMarkerIds.push(marker.request.id);
        rawMarkers.put(marker);
      },
    };
    const realStore = nu.createNodeBundleStore(join(root, 'pending'));
    const bundleStore = {
      list: () => realStore.list(),
      read: (id: string) => realStore.read(id),
      remove: (id: string) => realStore.remove(id),
      put: (id: string, bytes: Uint8Array) => {
        if (storeMode === 'durable-store-put-THROWS') {
          const error: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device');
          error.code = 'ENOSPC';
          throw error;
        }
        realStore.put(id, bytes);
      },
    };
    const liveDurable = core.createDurableUploadPipeline({
      store: bundleStore,
      pipeline: realPipeline(c),
      newId: () => 'live-blob',
      onError: () => {},
    });
    const client = core.createClient({
      uploadPipeline: liveDurable,
      appToken: 'tok',
      getEnvironment: () => env,
      captureStore: core.createFileCaptureStore(nu.createFsChunkStorage(join(root, 'capture')), {
        generation,
        cleanOtherGenerations: false,
        clock,
      }),
      reportMarkers: { store: markerStore, generation },
      clock,
      scheduler: noopScheduler,
      onError: () => {},
    });
    client.launch();
    client.log(PRE_CRASH_LOG);
    await client.logException(new Error(incident));
    await settle();
    await client.stop(50);
    perLaunch.push(c.puts.slice(0));

    const afterLive = readNodeState(dir, [sub]);
    const staged: Staged[] = [
      // The RECORDING — the only artifact that always exists, whatever the store and the collector did.
      ...stagedGenerations(afterLive),
      // The marker the client minted for this incident, whether or not it is still there.
      ...mintedMarkerIds.map((id) => ({ slot: `${sub}!${id}`, incident })),
      // The staged blob, when the store took it.
      ...(afterLive.has(`${sub}/live-blob`)
        ? [{ slot: `${sub}/live-blob`, incident, ownSummary: incident }]
        : []),
    ];

    // ── launches 2..4: recovery, exactly as a later process would run it ─────────────────────────
    for (launch = 2; launch <= LAUNCHES; launch += 1) {
      const mark = c.puts.length;
      await recoverInstances({
        dataDir: dir,
        ownInstanceId: `1-0-next${launch}`,
        uploadPipeline: realPipeline(c),
        context: ctx,
        onError: () => {},
      });
      await settle();
      perLaunch.push(c.puts.slice(mark));
    }

    judgeCrossLaunch({
      label: `L live ${answer.status} (${answer.intent}) ${storeMode}`,
      staged,
      // Both the live PUT and every rebuild carry the error's message as the summary.
      incidentOf: (summary: string) => (summary === incident ? incident : undefined),
      perLaunch,
      left: readNodeState(dir, [sub]),
      mustDeliver: answer.intent !== 'refuse',
    });
    judgePayload(`L live ${answer.status} (${answer.intent}) ${storeMode}`, perLaunch.flat());
    rmSync(dir, { recursive: true, force: true });
  }

// ══ M. THE CONTROL PLANE — a failing /v2/sessions or /v2/issues, live then recovered ═══════════════
//
// Everything above answers the control plane 200 and only varies the signed PUT, so two whole classes
// were unrepresentable:
//
//   • a TRANSIENT control-plane failure that the SDK treats as terminal (R5-2: a 401/403 out of
//     `ensureSession` enters the kill state — capture and detection stopped, `launch()` a permanent
//     no-op — while `transport.ts` asserts eighty lines away that 401 is retryable);
//   • the collector's OWN error codes, which arrive inside an HTTP **200** envelope and share a numeric
//     field with HTTP statuses (R5-3), so Android's permanent codes are retried forever and an envelope
//     code that happens to read 401/403 is misread as an auth status.
//
// The collector's intent is declared per case, exactly as everywhere else, and it BEHAVES that way: a
// `transient` condition clears after `CLEARS_AFTER`, a `refuse` never does. Two invariants apply:
//
//   P7  STAYS ALIVE   a condition the collector said would clear must not permanently disable capture.
//   P6  as above      a refusal is final: the SDK must stop asking on later launches.

/** The collector's `{ ok: false, error }` envelope — HTTP 200, which is the whole point. */
const envelope = (code: number, type: string) => ({
  status: 200,
  body: { ok: false, error: { type, message: type, code } },
});

interface ControlCase {
  label: string;
  /** Which call the collector answers this way. */
  on: 'session' | 'issue';
  /** The wire answer while the condition holds. */
  answer: { status: number; body: unknown };
  intent: Verdict;
  /** Must the client still be capturing after the live launch? (KILL_SDK is the one that may not.) */
  staysAlive: boolean;
}

/**
 * A collector-code case whose expected outcome is DERIVED from the Android-canonical table, not
 * hand-declared here.
 *
 * These were a SECOND hand-transcription of `CommunicationErrorClassifier.java` — the same table the
 * SDK transcribes — so a mistake made in both places was invisible to every one of these cases. Sharing
 * one table is safe only because `core/src/collector-error-codes.drift.test.ts` now parses that Java
 * file and fails if the table disagrees with it: the shared source is checked against CANON rather than
 * against another copy of itself.
 */
const collectorCase = (on: 'session' | 'issue', code: number, type: string): ControlCase => {
  const category: string = core.SERVER_ERROR_CATEGORIES[code] ?? 'transient';
  return {
    label: `${on} code ${code} ${type}`,
    on,
    answer: envelope(code, type),
    intent: category === 'permanent' || category === 'kill_sdk' ? 'refuse' : 'transient',
    // Only KILL_SDK may silence the SDK. A `permanent` verdict drops THIS payload and nothing else —
    // three of these cases used to declare otherwise, left over from when a bad token killed the client.
    staysAlive: category !== 'kill_sdk',
  };
};

/**
 * The SAME collector envelope, delivered with a NON-2xx status instead of the usual 200.
 *
 * The gap this closes. `bugsee-api.ts` threw on the status BEFORE reading the body, so a verdict the SDK
 * honours perfectly on an HTTP 200 was thrown away the moment the collector attached a status to it:
 * `14019 InvalidAppToken` on a 400 was retried at every launch for the life of the installation, and
 * `99099 KillSdk` on a 400 could not switch the SDK off at all. Android reads the body on BOTH endpoints'
 * failure paths — `ReportUploadExecutor.java:468-484` for `/v2/issues`, `CommunicationRequests.obtainSession`
 * for `/v2/sessions` — and lets the collector's code win over the status.
 *
 * The expected outcome is DERIVED from the same Android-canonical table as {@link collectorCase}, so this
 * adds no second opinion about which codes are permanent: it asserts only that the STATUS does not change
 * the answer.
 */
const collectorCaseOverHttp = (
  on: 'session' | 'issue',
  status: number,
  code: number,
  type: string,
): ControlCase => ({
  ...collectorCase(on, code, type),
  label: `${on} HTTP ${status} carrying code ${code} ${type}`,
  answer: { status, body: { ok: false, error: { type, message: type, code } } },
});

/**
 * A NAKED non-2xx on the control plane — a status with no collector code behind it.
 *
 * These are declared TRANSIENT, and that is the decision this harness exists to keep honest rather than
 * an observation about HTTP. A bare 4xx on the control plane is the answer an INTERMEDIARY gives — a
 * captive portal, a corporate MITM proxy, a WAF, a stale CDN route, a service worker — none of which read
 * the payload, and all of which go away. Android's own two endpoints disagree about the identical status
 * (`/v2/issues` falls back to `classifyHttpStatus` → PERMANENT; `/v2/sessions` falls back to
 * `classifyServerErrorCode(0)` → TRANSIENT), which is the tell that a status is not a verdict about the
 * bytes. So the SDK keeps the report, and these cases assert that it is still there to deliver once the
 * interposer is gone — P4 fires if a future change starts deleting on a status.
 *
 * "Retried forever" is answered by BOUNDS instead: node's 7-day dead-subtree sweep, the durable queue's
 * own retention, and — new with these cases — the same age bound on the browser/worker sibling leg (set N).
 */
const bareStatusCase = (on: 'session' | 'issue', status: number): ControlCase => ({
  label: `${on} HTTP ${status} with NO collector code (an intermediary answered)`,
  on,
  answer: { status, body: { message: 'Bad Request' } },
  intent: 'transient',
  staysAlive: true,
});

const CONTROL_CASES: ControlCase[] = [
  // ── R5-2: an HTTP auth status on the control plane. Android treats 401 as session expiry and
  //    retries once (`BugseeCommunicationManager.java:614-635`); the token blacklist fires ONLY on
  //    the server error code KILL_SDK (`:776-781`), never on an HTTP status.
  {
    label: 'session HTTP 401',
    on: 'session',
    answer: { status: 401, body: {} },
    intent: 'transient',
    staysAlive: true,
  },
  {
    label: 'session HTTP 403',
    on: 'session',
    answer: { status: 403, body: {} },
    intent: 'transient',
    staysAlive: true,
  },
  // ── R5-3: the collector's OWN codes, inside an HTTP 200 envelope.
  //    TRANSIENT (Android's `default:` arm, and 99013 explicitly).
  {
    label: 'session code 99013 ServerTooBusy',
    on: 'session',
    answer: envelope(99013, 'ServerTooBusyError'),
    intent: 'transient',
    staysAlive: true,
  },
  {
    label: 'session code 14002 SessionNotFound',
    on: 'session',
    answer: envelope(14002, 'SessionNotFoundError'),
    intent: 'transient',
    staysAlive: true,
  },
  //    …and the two whose numbers COLLIDE with HTTP statuses. Neither is in the collector's permanent
  //    set, so neither may kill anything — the collision is the finding.
  {
    label: 'session code 403 (a COLLECTOR code, not a status)',
    on: 'session',
    answer: envelope(403, 'SomeCollectorError'),
    intent: 'transient',
    staysAlive: true,
  },
  collectorCase('session', 401, 'SomeCollectorError'), // a COLLECTOR code, not a status
  //    PERMANENT: the payload can never be accepted, so it must be dropped rather than re-sent at
  //    every launch for the life of the installation — but the SDK keeps RECORDING.
  collectorCase('session', 14019, 'InvalidAppTokenError'),
  collectorCase('session', 11004, 'ApplicationTypeMismatchError'),
  collectorCase('session', 99098, 'UnsupportedSdkError'),
  //    KILL_SDK — permanent AND the one case where going quiet is the CORRECT outcome.
  collectorCase('session', 99099, 'KillSdkError'),
  //    The same namespace on the ISSUE call.
  collectorCase('issue', 12003, 'SimilarCrashExistsError'),
  collectorCase('issue', 99013, 'ServerTooBusyError'),
  //    ── The same codes with an HTTP STATUS attached. The status must not change the verdict, in
  //       EITHER direction: a permanent code stays permanent, and ServerTooBusy stays retryable even
  //       though it arrived on a 503 that a status-first reading would also have called retryable —
  //       and on a 400 that a status-first reading would have DELETED.
  collectorCaseOverHttp('issue', 400, 14019, 'InvalidAppTokenError'),
  collectorCaseOverHttp('issue', 403, 11004, 'ApplicationTypeMismatchError'),
  collectorCaseOverHttp('issue', 404, 99098, 'UnsupportedSdkError'),
  collectorCaseOverHttp('issue', 422, 12004, 'TooManySimilarCrashesError'),
  collectorCaseOverHttp('issue', 503, 99013, 'ServerTooBusyError'),
  collectorCaseOverHttp('issue', 400, 99013, 'ServerTooBusyError'),
  collectorCaseOverHttp('session', 400, 14019, 'InvalidAppTokenError'),
  collectorCaseOverHttp('session', 401, 14002, 'SessionNotFoundError'),
  collectorCaseOverHttp('session', 400, 99099, 'KillSdkError'),
  collectorCaseOverHttp('session', 500, 99013, 'ServerTooBusyError'),
  //    ── …and the naked statuses, which stay retryable BY DECISION (see bareStatusCase).
  bareStatusCase('issue', 400),
  bareStatusCase('issue', 403),
  bareStatusCase('issue', 404),
  bareStatusCase('issue', 422),
  bareStatusCase('session', 400),
  bareStatusCase('session', 404),
];

for (const control of CONTROL_CASES) {
  cases += 1;
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-inv-m-'));
  const sub = '9-9-dead';
  const root = join(dir, sub);
  nu.ensureDir(root);
  nu.writeFileSecure(
    join(root, 'owner.json'),
    JSON.stringify({ instanceId: sub, pid: 999_999, threadId: 0, startedAt: 1, version: '0' }),
  );

  const generation = 950;
  const incident = 'CONTROL';
  generationIncident.set(`${sub}~g${generation}`, incident);

  let launch = 1;
  /** The condition holds while it holds; a `transient` one clears, a `refuse` one never does. */
  const holds = (): boolean => control.intent === 'refuse' || launch <= CLEARS_AFTER;
  const answerWith = (): ControlAnswer =>
    holds() ? { ...control.answer, verdict: control.intent } : undefined;
  const c = collector(() => 200, {
    about: incident,
    ...(control.on === 'session' ? { session: answerWith } : { issue: answerWith }),
  });

  const perLaunch: Answered[][] = [];
  const rawMarkers = nu.createNodeReportMarkerStore(join(root, 'incidents'));
  const mintedMarkerIds: string[] = [];
  const markerStore = {
    list: () => rawMarkers.list(),
    remove: (id: string) => rawMarkers.remove(id),
    put: (marker: any) => {
      mintedMarkerIds.push(marker.request.id);
      rawMarkers.put(marker);
    },
  };
  const liveDurable = core.createDurableUploadPipeline({
    store: nu.createNodeBundleStore(join(root, 'pending')),
    pipeline: realPipeline(c),
    newId: () => 'live-blob',
    onError: () => {},
  });
  const client = core.createClient({
    uploadPipeline: liveDurable,
    appToken: 'tok',
    getEnvironment: () => env,
    captureStore: core.createFileCaptureStore(nu.createFsChunkStorage(join(root, 'capture')), {
      generation,
      cleanOtherGenerations: false,
      clock,
    }),
    reportMarkers: { store: markerStore, generation },
    clock,
    scheduler: noopScheduler,
    onError: () => {},
  });
  client.launch();
  client.log(PRE_CRASH_LOG);
  await client.logException(new Error(incident));
  await settle();
  const stillCapturing = client.isLaunched();
  await client.stop(50);
  perLaunch.push(c.puts.slice(0));

  const afterLive = readNodeState(dir, [sub]);
  const staged: Staged[] = [
    ...stagedGenerations(afterLive),
    ...mintedMarkerIds.map((id) => ({ slot: `${sub}!${id}`, incident })),
    ...(afterLive.has(`${sub}/live-blob`)
      ? [{ slot: `${sub}/live-blob`, incident, ownSummary: incident }]
      : []),
  ];

  for (launch = 2; launch <= LAUNCHES; launch += 1) {
    const mark = c.puts.length;
    await recoverInstances({
      dataDir: dir,
      ownInstanceId: `1-0-next${launch}`,
      uploadPipeline: realPipeline(c),
      context: ctx,
      onError: () => {},
    });
    await settle();
    perLaunch.push(c.puts.slice(mark));
  }

  const label = `M ${control.label} (${control.intent})`;
  // P7 — liveness, asserted in BOTH directions. It used to check only the `staysAlive` side, so a case
  // declaring `staysAlive: false` silently opted out of the check entirely — and three cases declared it
  // wrongly, left over from when an invalid app token killed the client. A `permanent` verdict drops one
  // payload; only KILL_SDK may silence the SDK, and it MUST.
  if (control.staysAlive && !stillCapturing) {
    failures.push(
      `${label} :: P7 the client STOPPED CAPTURING after a failure that does not license it`,
    );
  }
  if (!control.staysAlive && stillCapturing) {
    failures.push(
      `${label} :: P7 the client KEPT CAPTURING after the collector switched the SDK off`,
    );
  }
  judgeCrossLaunch({
    label,
    staged,
    incidentOf: (summary: string) => (summary === incident ? incident : undefined),
    perLaunch,
    left: readNodeState(dir, [sub]),
    mustDeliver: control.intent !== 'refuse',
  });
  judgePayload(label, perLaunch.flat());
  rmSync(dir, { recursive: true, force: true });
}

// ══ N. THE BROWSER/WORKER AGE BOUND — the other half of "retried at every launch, forever" ═════════
//
// Set M pins what the SDK does when the collector gives a FINAL answer. This set pins what happens when
// it never gives one at all — the case the control-plane decision deliberately leaves retryable (a bare
// 4xx from an intermediary, an offline collector, a 5xx). On node such a blob is bounded twice over:
// `sweep-instances` reaps a dead instance's whole subtree at 7 days, and `recover()` applies the durable
// queue's retention. The browser/worker dead-sibling leg reads the dead instance's prefix DIRECTLY, so it
// met neither — and on the web an instance is dead the moment its tab closes, so the blob was re-offered
// on every launch for the lifetime of the installation. That is what `recoverSiblingBundleQueue`'s age
// bound closes, using the SAME `DEFAULT_DURABLE_RETENTION.maxAgeMs` the same bytes already meet on the
// same tier when the instance recovers its OWN queue.
//
// WHY THIS SET IS NOT JUDGED BY `judge`. Retention is the one licensed exception to P2 ("nothing is
// deleted that was not first delivered or refused"): giving up on a blob is, by definition, deleting one
// the collector never answered about. Routing it through `judge` would either report a violation the
// design intends or force P2 to be weakened for everyone, and a weakened P2 is how real losses hide. So
// the bound gets its own explicit assertions, and every OTHER blob in the case is still judged normally.
//
// The `firstSeenMs` dimension is the whole safety argument. A frame written before the header carried one
// reads as UNKNOWN, and unknown must NEVER expire — treating it as the epoch would delete every pending
// crash report on the first launch after an SDK upgrade, which is the exact loss the upgrade was
// installed to prevent. The `legacy` case below is that control, and it must be DELIVERED.

const AGE_DAY = 24 * 60 * 60 * 1000;
const AGE_NOW = Date.now();

/** A durable frame carrying an explicit staging time (or none at all, for the legacy control). */
const agedFrame = (sub: string, key: string, incident: string, firstSeenMs?: number) =>
  core.serializeBundle(
    {
      request: {
        type: 'crash',
        summary: blobSummary(sub, key),
        severity: 3,
        source: { type: 'crash', mechanism: 'uncaught' },
        created_on: '2026-05-29T00:00:00Z',
        environment: env,
      },
      body: new Uint8Array([1, 2, 3]),
      fileName: 'p.zip',
      reportId: incident,
    },
    firstSeenMs,
  );

for (const [label, staleFirstSeenMs, mustGiveUp] of [
  ['90 days old', AGE_NOW - 90 * AGE_DAY, true],
  ['one day old', AGE_NOW - AGE_DAY, false],
  ['no timestamp at all (staged by an older SDK)', undefined, false],
] as Array<[string, number | undefined, boolean]>) {
  cases += 1;
  const idb = new fidb.IDBFactory();
  const locks = fakeLocks();
  const sub = 'deadN';
  const bundles = bu.createIdbBlobStore({
    databaseName: bu.coexistenceDatabaseName(TOK),
    indexedDB: idb,
  });
  // The blob under test, plus a FRESH sibling that must be unaffected by whatever happens to it.
  await bundles.put(`${sub}/stale`, agedFrame(sub, 'stale', 'STALE', staleFirstSeenMs));
  await bundles.put(`${sub}/fresh`, agedFrame(sub, 'fresh', 'FRESH', AGE_NOW - AGE_DAY));

  // The collector is simply unreachable for the first two launches and then comes back — a TRANSIENT
  // condition throughout, so nothing here is ever refused. That is the point: the only thing that may
  // stop a blob being offered is the age bound.
  let launch = 1;
  const c = collector(() => (launch <= CLEARS_AFTER ? 503 : 200));
  const perLaunch: Answered[][] = [];
  for (; launch <= LAUNCHES; launch += 1) {
    const mark = c.puts.length;
    await bu
      .createCoexistence({
        appToken: TOK,
        persist: true,
        locks: locks.manager,
        indexedDB: idb,
        onError: () => {},
      })
      .recoverDeadSiblings({ uploadPipeline: realPipeline(c) });
    await settle();
    perLaunch.push(c.puts.slice(mark));
  }

  const name = `N browser age bound — a stale blob ${label}`;
  const offeredStale = c.puts.filter((p) => p.summary === blobSummary(sub, 'stale'));
  const left = await browserLeft(idb);
  if (mustGiveUp) {
    // GIVEN UP: never offered at all, and gone from the store — the self-DoS is over.
    if (offeredStale.length > 0) {
      failures.push(`${name} :: it was still OFFERED ${offeredStale.length}x past the age bound`);
    }
    if (left.has(`${sub}/stale`)) {
      failures.push(`${name} :: it was withheld from the collector but LEFT ON DISK forever`);
    }
  } else {
    // KEPT: offered, and delivered once the collector came back. A bound that eats these is a loss.
    if (!offeredStale.some((p) => p.verdict === 'accept')) {
      failures.push(`${name} :: it was NEVER DELIVERED, though the collector came back for it`);
    }
    if (left.has(`${sub}/stale`)) {
      failures.push(`${name} :: it was delivered and then LEFT ON DISK`);
    }
  }
  // …and the fresh sibling is judged exactly as any other blob: the bound must not touch it.
  judgeCrossLaunch({
    label: `${name} (its fresh neighbour)`,
    staged: [{ slot: `${sub}/fresh`, incident: 'FRESH', ownSummary: blobSummary(sub, 'fresh') }],
    incidentOf: (summary: string) => (summary === blobSummary(sub, 'fresh') ? 'FRESH' : undefined),
    perLaunch,
    left,
    mustDeliver: true,
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════

console.log(`\n${cases} cases swept, ${failures.length} invariant violations`);
for (const n of notes) console.log('  note:', n);
for (const f of failures) console.log('FAIL', f);
if (failures.length > 0) process.exitCode = 1;
