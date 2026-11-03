// A REAL React 18 tree with `BugseeErrorBoundary`: a component starts `play()` on an undecodable source, and the async rejection is
// handed to the boundary the standard way (`setState(() => { throw error })`). The boundary reports the ORIGINAL reason object, so the
// call site recorded when `play()` was called must be in the report. Run by `test/async-origin.adapters.browser.e2e.ts`.

import { launch } from '@bugsee/browser';
import { BugseeErrorBoundary } from '@bugsee/react';
import { Component, createElement } from 'react';
import { createRoot } from 'react-dom/client';

interface E2EWindow extends Window {
  __E2E__: { state: 'running' | 'done' | 'failed'; error?: string; sdkErrors: string[] };
  __E2E_COLLECTOR__?: string;
}
const w = window as unknown as E2EWindow;
const bridge: E2EWindow['__E2E__'] = { state: 'running', sdkErrors: [] };
w.__E2E__ = bridge;

// NOT `return video.play()`: that is a tail call, and WebKit (proper tail calls) drops this very frame from the stack.
function playFromReactMount(video: HTMLVideoElement): Promise<void> {
  const playing = video.play();
  return playing;
}

class Player extends Component {
  override componentDidMount(): void {
    const video = document.createElement('video');
    video.src = '/broken.mp4';
    playFromReactMount(video).catch((error: unknown) => {
      this.setState(() => {
        throw error; // into the nearest error boundary
      });
    });
  }
  override render(): null {
    return null;
  }
}

async function main(): Promise<void> {
  const endpoint = w.__E2E_COLLECTOR__;
  if (endpoint === undefined || endpoint === '') {
    throw new Error('__E2E_COLLECTOR__ is not set');
  }
  await launch('e2e-app-token', {
    endpoint,
    appVersion: '1.0.0',
    appBuild: '1',
    persist: false,
    recover: false,
    onError: (e: unknown) => bridge.sdkErrors.push(String(e)),
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  createRoot(host).render(
    createElement(
      BugseeErrorBoundary,
      { fallback: createElement('p', null, 'failed') },
      createElement(Player),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
}

main().then(
  () => {
    bridge.state = 'done';
  },
  (err: unknown) => {
    bridge.error = String(err);
    bridge.state = 'failed';
  },
);
