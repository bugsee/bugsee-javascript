import { describe, expect, it } from 'vitest';
import { metaAppIdentity } from './app-identity';

const docWith = (meta: Record<string, string | null>): Document =>
  ({
    querySelector: (selector: string) => {
      const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1] ?? '';
      return name in meta ? { getAttribute: () => meta[name] } : null;
    },
  }) as unknown as Document;

describe('metaAppIdentity', () => {
  it('reads the declared version and build', () => {
    expect(
      metaAppIdentity(docWith({ 'bugsee:app-version': '1.2.3', 'bugsee:app-build': '45' }))(),
    ).toEqual({ version: '1.2.3', build: '45' });
  });

  it('trims padding a template left in the content attribute', () => {
    expect(
      metaAppIdentity(
        docWith({ 'bugsee:app-version': '  1.2.3\n', 'bugsee:app-build': '\t45 ' }),
      )(),
    ).toEqual({ version: '1.2.3', build: '45' });
  });

  it('leaves a missing, null or blank attribute undefined', () => {
    expect(metaAppIdentity(docWith({}))()).toEqual({ version: undefined, build: undefined });
    expect(metaAppIdentity(docWith({ 'bugsee:app-version': null }))()?.version).toBeUndefined();
    expect(metaAppIdentity(docWith({ 'bugsee:app-version': '   ' }))()?.version).toBeUndefined();
  });

  it('knows nothing without a document', () => {
    expect(metaAppIdentity(undefined)()).toBeUndefined();
  });
});
