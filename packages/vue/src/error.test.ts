import type { Bugsee } from '@bugsee/browser';
import { BUGSEE_SDK_VERSION } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBugseeErrorHandler, reportVueError, type VueAppLike } from './error';

function fakeClient() {
  const logException = vi.fn(
    (
      _error: unknown,
      _options?: { mechanism?: string; labels?: string[] },
    ): Promise<{ ok: true }> => Promise.resolve({ ok: true }),
  );
  return { client: { logException } as unknown as Bugsee, logException };
}

// A structural Vue component instance (options-API name / SFC __name) — no vue import.
const instance = (over: Record<string, unknown>) => over;

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('reportVueError', () => {
  it('reports the error with the default `uncaught` mechanism and the Vue info as a label', () => {
    const { client, logException } = fakeClient();
    reportVueError(new Error('boom'), { info: 'render function', getClient: () => client });
    expect(logException).toHaveBeenCalledTimes(1);
    const opts = logException.mock.calls[0]?.[1];
    expect(opts?.mechanism).toBe('uncaught');
    expect(opts?.labels).toContain('vue.info:render function');
  });

  it('labels the component name from the instance ($options.name)', () => {
    const { client, logException } = fakeClient();
    reportVueError(new Error('x'), {
      instance: instance({ $options: { name: 'UserCard' } }),
      getClient: () => client,
    });
    expect(logException.mock.calls[0]?.[1]?.labels).toContain('vue.component:UserCard');
  });

  it('derives the component name from $.type.name (resolved component) when $options.name is absent', () => {
    const { client, logException } = fakeClient();
    reportVueError(new Error('x'), {
      instance: instance({ $: { type: { name: 'Profile' } } }),
      getClient: () => client,
    });
    expect(logException.mock.calls[0]?.[1]?.labels).toContain('vue.component:Profile');
  });

  it('derives the component name from a functional component $.type.displayName', () => {
    const { client, logException } = fakeClient();
    reportVueError(new Error('x'), {
      instance: instance({ $: { type: { displayName: 'Avatar' } } }),
      getClient: () => client,
    });
    expect(logException.mock.calls[0]?.[1]?.labels).toContain('vue.component:Avatar');
  });

  it('derives the component name from an SFC instance ($.type.__name) when nothing explicit is set', () => {
    const { client, logException } = fakeClient();
    reportVueError(new Error('x'), {
      instance: instance({ $: { type: { __name: 'Dashboard' } } }),
      getClient: () => client,
    });
    expect(logException.mock.calls[0]?.[1]?.labels).toContain('vue.component:Dashboard');
  });

  it('omits labels entirely when there is no component name and no info', () => {
    const { client, logException } = fakeClient();
    reportVueError(new Error('x'), { getClient: () => client });
    expect(logException.mock.calls[0]?.[1]?.labels).toBeUndefined();
  });

  it('tolerates a null instance (Vue passes null with no component context) — no throw, no component label', () => {
    const { client, logException } = fakeClient();
    // The guard must handle null: `null.$options` would throw if dropped. Vue genuinely passes null here.
    expect(() =>
      reportVueError(new Error('x'), { instance: null, info: 'setup', getClient: () => client }),
    ).not.toThrow();
    expect(logException.mock.calls[0]?.[1]?.labels).toEqual(['vue.info:setup']); // only the info label
  });

  it('ignores a nameless object instance (no component label)', () => {
    const { client, logException } = fakeClient();
    reportVueError(new Error('x'), {
      instance: { $options: {} },
      info: 'setup',
      getClient: () => client,
    });
    expect(logException.mock.calls[0]?.[1]?.labels).toEqual(['vue.info:setup']);
  });

  it('adds NO vue.info label for an empty info string', () => {
    // Vue passes `info` on every call; an empty one carries no information, and a bare `vue.info:` label
    // would be an issue-search facet that matches everything and means nothing.
    const { client, logException } = fakeClient();
    reportVueError(new Error('x'), {
      info: '',
      instance: instance({ $options: { name: 'Widget' } }),
      getClient: () => client,
    });
    expect(logException.mock.calls[0]?.[1]?.labels).toEqual(['vue.component:Widget']);
  });

  it('omits labels entirely when the info is empty and there is no component name', () => {
    const { client, logException } = fakeClient();
    reportVueError(new Error('x'), { info: '', getClient: () => client });
    expect(logException.mock.calls[0]?.[1]?.labels).toBeUndefined();
  });

  it('applies a mechanism override', () => {
    const { client, logException } = fakeClient();
    reportVueError(new Error('x'), { getClient: () => client, mechanism: 'programmatic' });
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('programmatic');
  });

  it('is a no-op when no client is resolvable', () => {
    expect(() => reportVueError(new Error('x'), { getClient: () => undefined })).not.toThrow();
  });

  it('falls back to the carrier client when no getClient is injected', () => {
    const { client, logException } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { [BUGSEE_SDK_VERSION]: { client } };
    reportVueError(new Error('via-carrier'));
    expect(logException).toHaveBeenCalledTimes(1);
  });
});

describe('installBugseeErrorHandler', () => {
  it('installs app.config.errorHandler so a Vue error is reported with info + component', () => {
    const { client, logException } = fakeClient();
    const app: VueAppLike = { config: {} };
    installBugseeErrorHandler(app, { getClient: () => client });
    app.config.errorHandler?.(
      new Error('render boom'),
      instance({ $options: { name: 'Widget' } }),
      'render function',
    );
    const opts = logException.mock.calls[0]?.[1];
    expect(opts?.labels).toEqual(['vue.component:Widget', 'vue.info:render function']);
  });

  it('CHAINS a pre-existing errorHandler (the app keeps its own handler)', () => {
    const { client } = fakeClient();
    const previous = vi.fn();
    const app: VueAppLike = { config: { errorHandler: previous } };
    installBugseeErrorHandler(app, { getClient: () => client });
    const err = new Error('x');
    const inst = instance({});
    app.config.errorHandler?.(err, inst, 'mounted hook');
    expect(previous).toHaveBeenCalledWith(err, inst, 'mounted hook'); // the app's handler still runs
  });
});
