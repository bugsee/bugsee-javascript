import { handle as bugseeHandle, handleErrorWithBugsee } from '@bugsee/sveltekit';
import { registerServer } from '@bugsee/sveltekit/server';
import { sequence } from '@sveltejs/kit/hooks';

// Launch the node SDK, pointed at the mock collector via env (the port is only known at test time). Lean,
// deterministic capture: memory store, no background detectors/traces.
registerServer('e2e-token', {
  endpoint: process.env.BUGSEE_ENDPOINT,
  capturedDataStore: 'memory',
  detectHangs: false,
  captureSystemTraces: false,
  captureSystemEvents: false,
});

export const handle = sequence(bugseeHandle);
export const handleError = handleErrorWithBugsee();
