// The "source-map half" deliverable (docs/samples/PLAN.md §5.7e): throw from the PRODUCTION
// (minified, hidden-source-map) build and let the SDK report it, so a human/agent can then check via
// MCP (list_issues/get_issue on SWEBPACK) that the stack resolved to original TS sources + line
// numbers, not minified bundle locations.
//
// Prereqs: `pnpm build` (real BUGSEE_APP_TOKEN, uploads the real source maps to staging) then
// `pnpm preview` (serves dist/ on :5322 + the local API on :5346) running in another terminal.
import { chromium } from 'playwright';

const BASE = 'http://localhost:5322';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true });

  const bugseeCalls = [];
  page.on('response', (res) => {
    if (res.url().includes('bugsee.com')) bugseeCalls.push({ url: res.url(), status: res.status() });
  });

  await page.goto(`${BASE}/#/scenarios`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="s4-error"]', { timeout: 10_000 });
  await page.click('[data-testid="s4-error"]');
  await page.waitForTimeout(2000);
  await page.click('[data-testid="s1-flush"]');
  await page.waitForTimeout(2500);

  const issueCalls = bugseeCalls.filter((c) => c.url.includes('issues'));
  console.log(`Bugsee calls observed: ${bugseeCalls.length} (issue calls: ${issueCalls.length})`);
  console.log('Reported from the PRODUCTION (hidden-source-map, debug-id-injected) bundle.');
  console.log('Now check MCP: list_issues(SWEBPACK) -> the newest issue -> get_issue -> the stack');
  console.log('should read ".../src/scenarios.ts:<line>" (the throw inside the s4-error handler),');
  console.log('NOT a minified/hashed chunk location like ".../assets/main.<hash>.js:1:12345".');

  await browser.close();
  if (issueCalls.length === 0) {
    console.error('No issue call observed — nothing to check on the backend.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
