// Main-process half of the real-Electron smoke (see ../electron-smoke.mts). Bundled by the runner and
// executed INSIDE a real Electron main process: real `app` / `ipcMain` / `BrowserWindow` / `crashReporter`
// are handed to the real `launchMain`; only the HTTP transport is a recorder (no network is touched).
import { strFromU8, unzipSync } from 'fflate';
import { launchMain } from '../../../electron/src/main';

// The bundle runs under Electron's main process, where `require` is the CJS one.
// biome-ignore lint/suspicious/noExplicitAny: the Electron module is injected by the runtime, untyped here.
declare const require: (id: string) => any;
const electron = require('electron');
const { app, BrowserWindow, ipcMain, crashReporter, powerMonitor, screen, session } = electron;

const dir = process.env.BUGSEE_SMOKE_DIR as string;
const puts: Uint8Array[] = [];
const perms: string[] = [];
const json = (o: unknown) => new Uint8Array(Buffer.from(JSON.stringify(o)));
const none = { status: 200, headers: {}, body: new Uint8Array() };
const transport = async (url: string, o: { body?: Uint8Array } = {}) => {
  if (url.endsWith('/v2/sessions'))
    return { status: 200, headers: {}, body: json({ access_token: 'a' }) };
  if (url.endsWith('/v2/issues'))
    return {
      status: 200,
      headers: {},
      body: json({ endpoint: 'https://s3.test/put', issueId: 'i', recordingId: 'r' }),
    };
  if (url === 'https://s3.test/put' && o.body) puts.push(o.body);
  return none;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Poll a condition instead of sleeping a fixed time, so a slow runner waits and a fast one does not.
async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
  tries = 80,
): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    const v = await read();
    if (v) return v;
    await sleep(250);
  }
  return undefined;
}

const out: Record<string, unknown> = {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
};

app.whenReady().then(async () => {
  try {
    const errors: string[] = [];
    session.defaultSession.setPermissionRequestHandler(
      (_wc: unknown, permission: string, cb: (ok: boolean) => void) => {
        perms.push(permission);
        cb(false);
      },
    );
    const client = launchMain('tok', {
      ipcMain,
      app,
      powerMonitor,
      screen,
      BrowserWindow,
      crashReporter,
      transport,
      captureNetwork: false,
      capturedDataStore: 'memory',
      detectHangs: false,
      onError: (e: unknown) => errors.push(String((e as Error)?.stack ?? e)),
    } as never);
    // The configuration the README documents as the recommended one: sandboxed, isolated, no node.
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: `${dir}/preload.cjs`,
      },
    });
    win.webContents.on('preload-error', (_e: unknown, _p: string, err: Error) => {
      out.preloadError = String(err?.stack ?? err);
    });
    await win.loadFile(`${dir}/index.html`);
    out.renderer = await until(() => win.webContents.executeJavaScript('window.__result'));
    out.rendererGlobals = await win.webContents.executeJavaScript(
      'typeof require + "/" + typeof process',
    );
    await client.logException(new Error('electron smoke'));
    const bundle = await until(() => puts[0]);
    if (bundle) {
      const files = unzipSync(bundle);
      out.files = Object.keys(files);
      out.logs = JSON.parse(strFromU8(files['logs.json'] as Uint8Array));
    }
    out.bundles = puts.length;
    out.errors = errors;
    // Informational only (not asserted): which permission Electron routes getDisplayMedia through.
    try {
      out.displayMedia = await win.webContents.executeJavaScript(
        'navigator.mediaDevices.getDisplayMedia({video:true}).then(()=>"granted",e=>"denied:"+e.name)',
        true,
      );
    } catch (e) {
      out.displayMedia = `threw ${e}`;
    }
    out.perms = perms;
    await client.stop();
  } catch (e) {
    out.fatal = String((e as Error)?.stack ?? e);
  }
  console.log(`RESULT_JSON ${JSON.stringify(out)}`);
  app.exit(0);
});
