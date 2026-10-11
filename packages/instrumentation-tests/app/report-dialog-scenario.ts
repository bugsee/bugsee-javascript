// The page script of `test/report-dialog.e2e.ts`: the REAL `@bugsee/browser` launch, exposing the client on
// `window` so the harness (Playwright) can open the report dialog and log around it.
import { launch } from '@bugsee/browser';

interface DialogWindow extends Window {
  __E2E_COLLECTOR__?: string;
  __E2E_OPTIONS__?: Record<string, unknown>;
  __bugsee?: Awaited<ReturnType<typeof launch>>;
  __sdkErrors: string[];
  __ready?: boolean;
}

const w = window as unknown as DialogWindow;
w.__sdkErrors = [];

(async () => {
  const collector = w.__E2E_COLLECTOR__;
  if (collector === undefined) {
    throw new Error('__E2E_COLLECTOR__ is not set');
  }
  w.__bugsee = await launch('e2e-app-token', {
    endpoint: collector,
    appVersion: '1.2.3',
    appBuild: '42',
    replay: false,
    persist: false,
    recover: false,
    onError: (error: unknown) => w.__sdkErrors.push(String(error)),
    ...w.__E2E_OPTIONS__,
  });
  w.__ready = true;
})();
