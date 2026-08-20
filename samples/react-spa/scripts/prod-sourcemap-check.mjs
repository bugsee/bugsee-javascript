// The "source-map half" deliverable: throw from the PRODUCTION (minified) build and let the SDK report
// it, so a human/agent can then check via MCP (list_issues/get_issue on SREACT) that the stack resolved
// to original TSX sources + line numbers, not minified bundle locations.
//
// Prereqs: `pnpm build` (with BUGSEE_CLI_PATH set — see README.md's F-6 note) then
// `pnpm preview:app` + `pnpm dev:api` running on :5302 / :5330.
import { chromium } from 'playwright';
import { CHROMIUM_ARGS, installStagingWorkarounds } from './staging-workarounds.mjs';

const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const page = await browser.newPage({ ignoreHTTPSErrors: true });
await installStagingWorkarounds(page);

await page.goto('http://localhost:5302/scenarios', { waitUntil: 'networkidle' });
await page.click('[data-testid="s4-error"]');
await page.waitForTimeout(2500);
await page.click('[data-testid="s1-flush"]');
await page.waitForTimeout(2500);
console.log('Reported from the production bundle. Now check MCP: list_issues(SREACT) -> the newest');
console.log('issue -> get_issue -> the stack should read ".../src/routes/ScenarioPage.tsx:296", not a');
console.log('minified chunk location.');
await browser.close();
