import { launchCore as nodeLaunchCore } from '@bugsee/node';
import { describe, expect, it, vi } from 'vitest';
import { launchCore } from './launch';

// The gate is asserted against the option this tier hands the node composition, because that is the
// only place the decision exists — the capture itself lives in @bugsee/node.
vi.mock('@bugsee/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/node')>();
  return { ...actual, launchCore: vi.fn(() => ({ client: undefined, internals: undefined })) };
});

const optionsPassed = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  vi.mocked(nodeLaunchCore).mockClear();
  launchCore('tok', over as never);
  return vi.mocked(nodeLaunchCore).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
};

describe('@bugsee/bun — local variables are gated OFF', () => {
  it('never enables local-variable capture', () => {
    expect(optionsPassed().captureLocalVariables).toBe(false);
  });

  it('cannot be re-enabled by the caller — the gate wins over the option', () => {
    // Not a default. A default spreads BEFORE `...options` and a caller would override it; this is
    // applied after, because on this runtime the feature does not merely fail, it must not be tried.
    expect(optionsPassed({ captureLocalVariables: true }).captureLocalVariables).toBe(false);
    expect(
      optionsPassed({ captureLocalVariables: { includeCaught: true } }).captureLocalVariables,
    ).toBe(false);
  });

  it('leaves every OTHER option alone', () => {
    // The gate is surgical: it must not become a place where unrelated options quietly die.
    expect(optionsPassed({ appVersion: '9.9.9' }).appVersion).toBe('9.9.9');
  });
});
