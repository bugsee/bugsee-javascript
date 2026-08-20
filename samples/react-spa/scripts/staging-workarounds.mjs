// The one workaround this sample still needs, and it is NOT an SDK defect.
//
// CORS: apidev.bugsee.com's CORS policy answers a hardcoded
// `Access-Control-Allow-Origin: https://appdev.bugsee.com` regardless of the requesting origin, and
// its `Access-Control-Allow-Headers` omits `x-app-token` and `x-bugsee-internal`, which the SDK
// sends on every call. A browser on any other origin — this dev server, or a real customer's
// domain — is refused before the request is made. See samples/FINDINGS.md.
//
// `--disable-web-security` bypasses it here ONLY so the rest of this sample's verification can reach
// the real backend. A real end user cannot do this; the fix belongs in the collector's CORS policy
// for the SDK ingest routes, which authenticate by app token and need no cookie credentials.
//
// This file previously also rewrote `x-client-type`, unwrapped the `{ok, result}` response envelope
// and stripped `x-amz-checksum-sha256` from the bundle PUT, working around three SDK defects this
// sample found. All three are fixed in @bugsee/core, so the request patching is gone: the sample now
// exercises exactly the requests a customer's browser makes.

export const CHROMIUM_ARGS = ['--disable-web-security', '--disable-site-isolation-trials'];

/** Nothing to patch any more — kept so callers stay stable if a future workaround is needed. */
export async function installStagingWorkarounds(_page) {
  // intentionally empty
}
