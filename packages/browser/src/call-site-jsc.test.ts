import { createClient } from '@bugsee/core';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStack } from './stack';

// a non-Error throwable's synthetic stack must start at the APPLICATION on JavaScriptCore too. These
// strings were recorded from the macOS `jsc` shell (the engine under Safari and every iOS WebView),
// 2026-10-12, paths shortened: there is no `at`, frames are `function@location`.
//   - with Error.captureStackTrace: the boundary and everything above it are already dropped;
//   - without it: the whole stack, SDK frames first (internal logException, then the public wrapper -
//     JSC drops a tail-calling frame, which is why the wrapper must not tail-call).
const JSC_BOUNDARY_DROPPED =
  'applicationCode@https://app.example.com/main.js:12:30\nglobal code@https://app.example.com/main.js:20:11';
const JSC_FULL_STACK =
  'internalLog@https://app.example.com/sdk.js:2:41\nlogException@https://app.example.com/sdk.js:4:49\napplicationCode@https://app.example.com/main.js:12:30\nglobal code@https://app.example.com/main.js:20:11';

const getEnvironment = () =>
  ({
    platform: { type: 'web', version: '1' },
    runtime: { type: 'web', version: '' },
    sdk: { version: '0', type: 'javascript' },
  }) as never;

function build() {
  const enqueue = vi.fn(async (_bundle: { body: Uint8Array }) => ({ ok: true }));
  const client = createClient({
    uploadPipeline: { enqueue, flush: async () => true, drop() {} } as never,
    appToken: 'tok',
    getEnvironment,
    stackParser: parseStack,
  });
  const members = (): (string | undefined)[] => {
    const body = (enqueue.mock.calls.at(-1)?.[0] as { body: Uint8Array }).body;
    const crash = JSON.parse(strFromU8(unzipSync(body)['crash.json'] as Uint8Array)) as {
      exception: { frames: { data?: { member?: string } }[] };
    };
    return crash.exception.frames.map((f) => f.data?.member);
  };
  return { client, members };
}

const RealError = Error;
afterEach(() => {
  vi.stubGlobal('Error', RealError);
});

describe('logException(non-Error) on JavaScriptCore stacks (R3P-1)', () => {
  it('with captureStackTrace: frame 0 is the application function', async () => {
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = (t: { stack?: string }) => {
      t.stack = JSC_BOUNDARY_DROPPED;
    };
    try {
      const { client, members } = build();
      await client.logException('a string');
      expect(members()).toEqual(['applicationCode', 'global code']);
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('without captureStackTrace: the wrapper + internal frames are dropped, frame 0 is the application', async () => {
    class JscError extends RealError {
      constructor() {
        super();
        Object.defineProperty(this, 'stack', { value: JSC_FULL_STACK });
      }
    }
    Object.defineProperty(JscError, 'captureStackTrace', { value: undefined });
    vi.stubGlobal('Error', JscError);
    const { client, members } = build();
    await client.logException('a string');
    expect(members()).toEqual(['applicationCode', 'global code']);
  });
});
