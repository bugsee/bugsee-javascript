// Ad-hoc helper used while producing the backend (MCP) evidence cited in scenarios.md/FINDINGS.md: a
// single isolated scenario-panel run against a running `pnpm dev` server (start one separately first).
// Not part of `pnpm verify` (that script only checks LOCAL-level results — see its own header comment
// for why). Kept as a runnable record of the exact steps, not a generated artifact.
import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:5301';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));

await page.goto(`${BASE_URL}/#/scenarios`, { waitUntil: 'load' });
await page.waitForTimeout(1200);

async function run(id) {
  await page.locator(`button[data-scenario="${id}"]`).click();
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el !== null && el.textContent !== 'running…' && el.textContent !== '—';
    },
    `td[data-result="${id}"]`,
    { timeout: 15000 },
  );
  const text = await page.locator(`td[data-result="${id}"]`).textContent();
  console.log(id, '->', text);
}

await run('S8-report-handler');
const flushed = await page.evaluate(() => window.__bugsee?.flush(8000));
console.log('flush ->', flushed);
await browser.close();
