// DIAGNOSTIC-ONLY workarounds for FOUR independent, unconditional SDK/backend defects discovered while
// building this sample — see FINDINGS.md F-1..F-4. Every one of them blocks 100% of real-browser data
// delivery to Bugsee staging, for EVERY runtime, regardless of app or scenario:
//
//   F-1 CORS:      apidev.bugsee.com's CORS policy hardcodes Access-Control-Allow-Origin to
//                  https://appdev.bugsee.com, rejecting every other origin (incl. any localhost dev
//                  server or real customer domain). A real end user's browser CANNOT work around this —
//                  we bypass it here (--disable-web-security) purely to keep investigating past it.
//   F-2 client-type: @bugsee/core's BugseeApi hardcodes `x-client-type: web` on every request
//                  (packages/core/src/bugsee-api.ts:38), but the appserver's isValidForClient rejects
//                  that for an app created with type "javascript" (ApplicationTypeMismatchError) — the
//                  exact app type docs/samples/PLAN.md §6 tells every sample to create. We rewrite the
//                  header to "javascript" so the request is accepted.
//   F-3 envelope:  BugseeApi.ensureSession/postIssue decode the response body as a FLAT shape
//                  (packages/core/src/bugsee-api.ts:72 and ~48-53), but the real server wraps every
//                  response in {ok, result: {...snake_case...}}. Silently yields accessToken=undefined /
//                  issueId=undefined — no throw, because the guards check `=== null`, not `undefined`.
//                  We unwrap + remap the response body so the SDK's own (buggy) flat decode works.
//   F-4 checksum:  BundleUploader always sends `x-amz-checksum-sha256` on the bundle PUT
//                  (packages/core/src/bundle-uploader.ts:25). The presigned S3 URLs this backend issues
//                  do NOT authorize that header for their SigV2 signature, so AWS rejects EVERY bundle
//                  PUT with SignatureDoesNotMatch — proven by curl reproduction in FINDINGS.md. We strip
//                  the header before it reaches S3.
//
// None of this is something a real customer can do. It exists ONLY so this sample can still prove out
// the REST of the pipeline (symbolication, redaction, environment fields, ...) end-to-end against a
// real backend, and so each of these four defects could be diagnosed precisely rather than just
// reported as "nothing arrives". A production launch of any JS-family sample against this backend today
// uploads NOTHING, ever, with all default behavior.

export const CHROMIUM_ARGS = ['--disable-web-security', '--disable-site-isolation-trials'];

/** Install the F-2/F-3 (apidev.bugsee.com) and F-4 (S3) route patches on a Playwright page. */
export async function installStagingWorkarounds(page) {
  await page.route('https://apidev.bugsee.com/**', async (route) => {
    const req = route.request();
    const headers = { ...req.headers(), 'x-client-type': 'javascript' }; // F-2
    const isSessions = req.url().endsWith('/v2/sessions') && req.method() === 'POST';
    const isIssues = req.url().endsWith('/v2/issues') && req.method() === 'POST';
    if (isSessions || isIssues) {
      const response = await route.fetch({ headers });
      let json;
      try {
        json = await response.json();
      } catch {
        return route.fulfill({ response });
      }
      let flat = json; // F-3
      if (json && json.ok && json.result) {
        const r = json.result;
        flat = {
          ...r,
          ok: json.ok,
          ...(isIssues ? { issueId: r.issue_id, recordingId: r.recording_id } : {}),
        };
      }
      return route.fulfill({ response, json: flat });
    }
    await route.continue({ headers });
  });

  await page.route('https://*.amazonaws.com/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'PUT') return route.continue();
    const headers = { ...req.headers() };
    delete headers['x-amz-checksum-sha256']; // F-4
    await route.continue({ headers });
  });
}
