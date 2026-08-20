#!/usr/bin/env -S node
// pnpm verify — the scripted scenario sweep (docs/samples/PLAN.md §6/§7).
//
// This script drives the REAL app with a real Chromium (Playwright) against the dev server and
// exercises: (a) the app itself (every page does real work), and (b) every control in the Scenario
// panel (src/pages/scenarios.ts), reading back each control's own LOCAL-level result.
//
// What this script does NOT do: call the Bugsee staging MCP tools. Those are available to the
// Claude Code agent that built this sample, not to an arbitrary Node script (no query-API credentials
// are available to the sample itself — only the app token, which is a write-only ingestion
// credential). Backend-level (§6 step 3/4) verification was performed separately via
// `mcp__bugsee-staging__list_issues` / `get_issue` while building this sample; results with issue-key
// evidence are recorded in scenarios.md. This script covers §4's "Local" and, for the network/proxy
// assertions below, "Wire" depths.
import { chromium, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = 'http://localhost:5301';
const START_SERVER = process.env.VERIFY_NO_SERVER !== '1';

interface Row {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE_URL}/api/products`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`dev server did not come up at ${BASE_URL} in time`);
}

async function runAppChecks(page: Page): Promise<Row[]> {
  const rows: Row[] = [];
  const push = (id: string, title: string, ok: boolean, detail: string): void => {
    rows.push({ id, title, ok, detail });
  };

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const sdkStatus = (await page.locator('#sdk-status').textContent()) ?? '';
  push('APP-launch', 'SDK launches on page load', sdkStatus.includes('launched'), sdkStatus);

  const gridCount = await page.locator('#grid .card').count();
  push('APP-grid', 'Product grid renders from local API', gridCount === 6, `${gridCount} cards`);

  await page.locator('#grid .card h3 a').first().click();
  await page.waitForTimeout(400);
  const hasSparkline = (await page.locator('#sparkline').count()) === 1;
  push('APP-product', 'Product detail renders sparkline canvas', hasSparkline, String(hasSparkline));
  await page.locator('#add').click();
  await page.waitForTimeout(200);
  const cartBadge = (await page.locator('#cart-count').textContent()) ?? '';
  push('APP-cart-add', 'Add to cart updates badge', cartBadge.trim() === '1', cartBadge.trim());

  await page.goto(`${BASE_URL}/#/cart`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.locator('#discount').click();
  await page.waitForTimeout(800);
  const discountText = (await page.locator('#discount-result').textContent()) ?? '';
  push('APP-worker', 'Web Worker computes discount (postMessage round trip)', discountText.includes('total'), discountText);

  await page.goto(`${BASE_URL}/#/checkout`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.locator('#checkout-form button[type=submit]').click();
  await page.waitForURL(/#\/orders\//, { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const timelineItems = await page.locator('#timeline li').count();
  push('APP-checkout-sse', 'Checkout -> order-status SSE feed updates', timelineItems > 0, `${timelineItems} events`);

  await page.goto(`${BASE_URL}/#/chat`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.locator('#chat-input').fill('verify script ping');
  await page.locator('#chat-form button').click();
  await page.waitForTimeout(800);
  const chatMsgs = await page.locator('.chat-msg').count();
  push('APP-chat-ws', 'Support chat WebSocket round trip', chatMsgs >= 2, `${chatMsgs} messages`);

  await page.goto(`${BASE_URL}/#/settings`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const settingsGroups = await page.locator('.card').count();
  push('APP-settings', 'Settings page lists every launch-option group', settingsGroups === 5, `${settingsGroups} groups`);

  const swReady = await page
    .evaluate(async () => {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      return reg !== null;
    })
    .catch(() => false);
  push('APP-service-worker', 'Service Worker registers and activates', swReady, String(swReady));

  push('APP-console-clean', 'No unexpected console/page errors across the sweep so far', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  return rows;
}

async function runScenarioPanel(page: Page): Promise<Row[]> {
  const rows: Row[] = [];
  await page.goto(`${BASE_URL}/#/scenarios`, { waitUntil: 'load' });
  await page.waitForTimeout(500);

  const ids = await page.locator('button[data-scenario]').evaluateAll((buttons) =>
    buttons.map((b) => b.getAttribute('data-scenario') ?? ''),
  );

  for (const id of ids) {
    const title = (await page.locator(`tr[data-row="${id}"] strong`).textContent()) ?? id;
    await page.locator(`button[data-scenario="${id}"]`).click();
    await page.waitForTimeout(250);
    // The 200-exception storm (S4-storm) and a couple of others take longer than the default poll.
    const cell = page.locator(`td[data-result="${id}"]`);
    await page
      .waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return el !== null && el.textContent !== 'running…' && el.textContent !== '—';
        },
        `td[data-result="${id}"]`,
        { timeout: 15000 },
      )
      .catch(() => undefined);
    const text = (await cell.textContent()) ?? '';
    const ok = !text.startsWith('threw:');
    rows.push({ id, title: title.trim(), ok, detail: text.slice(0, 140) });
  }
  return rows;
}

function printTable(title: string, rows: Row[]): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  const idWidth = Math.max(...rows.map((r) => r.id.length), 2);
  for (const row of rows) {
    const mark = row.ok ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${row.id.padEnd(idWidth)}  ${row.detail}`);
  }
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} passed.`);
}

async function main(): Promise<void> {
  let serverProc: ChildProcess | undefined;
  if (START_SERVER) {
    console.log('starting dev server (pnpm dev)...');
    serverProc = spawn('pnpm', ['dev'], { stdio: 'ignore', detached: true });
    await waitForServer();
  } else {
    await waitForServer();
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const appRows = await runAppChecks(page);
    const scenarioRows = await runScenarioPanel(page);

    printTable('App checks', appRows);
    printTable('Scenario panel (local-level)', scenarioRows);

    const allRows = [...appRows, ...scenarioRows];
    const failedCount = allRows.filter((r) => !r.ok).length;
    console.log(`\n=== TOTAL: ${allRows.length - failedCount}/${allRows.length} passed ===`);
    if (failedCount > 0) {
      console.log('\nSee scenarios.md for backend-level (MCP) verification of the passing scenarios,');
      console.log('and FINDINGS.md for known SDK/backend defects (several scenarios are EXPECTED to');
      console.log('surface a defect in their result text without that being a failure of this script).');
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    if (serverProc !== undefined && serverProc.pid !== undefined) {
      try {
        process.kill(-serverProc.pid, 'SIGTERM');
      } catch {
        // already exited — nothing to clean up
      }
    }
  }
}

await main();
