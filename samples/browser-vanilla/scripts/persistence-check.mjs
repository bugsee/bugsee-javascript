import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// S12 (persistence & recovery): capture a crash, then KILL the browser process before it can finish
// uploading, then relaunch against the SAME profile dir (so IndexedDB persists) and confirm the SDK
// recovers and uploads the crash on the next launch.

const BASE_URL = 'http://localhost:5301';
const userDataDir = mkdtempSync(join(tmpdir(), 'bugsee-persist-check-'));
console.log('profile dir:', userDataDir);

const ctx1 = await chromium.launchPersistentContext(userDataDir, { headless: true });
const page1 = await ctx1.newPage();
await page1.goto(`${BASE_URL}/#/scenarios`, { waitUntil: 'load' });
await page1.waitForTimeout(1500);
await page1.evaluate(() => window.__bugsee?.setAttribute('persistCheck', 'run-1'));
await page1.locator('button[data-scenario="S5-uncaught"]').click();
// Give the capture store a moment to write the entry durably, but NOT enough time for the
// session/issue/PUT round trip to complete — that's the point of this test.
await page1.waitForTimeout(300);
console.log('killing every chromium process pinned to this profile dir (simulating a hard kill)...');
try {
  execSync(`pkill -9 -f "${userDataDir}"`);
} catch {
  // pkill exits non-zero when no process matched — fine, continue.
}
await new Promise((resolve) => setTimeout(resolve, 1500));

console.log('relaunching against the same profile...');
const ctx2 = await chromium.launchPersistentContext(userDataDir, { headless: true });
const page2 = await ctx2.newPage();
page2.on('pageerror', (e) => console.log('pageerror', e.message));
await page2.goto(`${BASE_URL}/`, { waitUntil: 'load' });
await page2.waitForTimeout(4000);
const flushed = await page2.evaluate(() => window.__bugsee?.flush(6000));
console.log('post-recovery flush ->', flushed);
await ctx2.close();
console.log('done');
