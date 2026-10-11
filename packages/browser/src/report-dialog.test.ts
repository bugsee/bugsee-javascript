// @vitest-environment jsdom
import type { UploadOptions, UploadResult } from '@bugsee/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createReportDialogLauncher,
  type ReportDialogDeps,
  type ReportDialogUiOptions,
} from './report-dialog';
import { DEFAULT_REPORT_DIALOG_STRINGS } from './report-dialog-strings';

const UI: ReportDialogUiOptions = {
  summaryRequired: false,
  descriptionRequired: false,
  emailRequired: false,
  labelsEnabled: false,
  labelsRequired: false,
  prioritySelectorEnabled: false,
  defaultSeverity: 'high',
};

interface Harness {
  deps: ReportDialogDeps;
  upload: ReturnType<typeof vi.fn<(options: UploadOptions) => Promise<UploadResult>>>;
  setUserIdentifier: ReturnType<typeof vi.fn<(email: string) => void>>;
  show: ReturnType<typeof createReportDialogLauncher>;
}

const harness = (
  overrides: Partial<ReportDialogDeps> = {},
  ui: Partial<ReportDialogUiOptions> = {},
): Harness => {
  const upload = vi.fn<(options: UploadOptions) => Promise<UploadResult>>(async () => ({
    ok: true,
  }));
  const setUserIdentifier = vi.fn<(email: string) => void>();
  const deps: ReportDialogDeps = {
    document,
    upload,
    isLaunched: () => true,
    getUserIdentifier: () => null,
    setUserIdentifier,
    sdkVersion: '0.1.0-test',
    ui: { ...UI, ...ui },
    ...overrides,
  };
  return { deps, upload, setUserIdentifier, show: createReportDialogLauncher(deps) };
};

const host = (): HTMLElement | null => document.querySelector('[data-bugsee-report-dialog]');
const root = (): ShadowRoot => {
  const shadow = host()?.shadowRoot;
  if (!shadow) throw new Error('no dialog host / shadow root');
  return shadow;
};
const q = <T extends Element>(selector: string): T => {
  const found = root().querySelector<T>(selector);
  if (!found) throw new Error(`not in dialog: ${selector}`);
  return found;
};
const field = (name: string): HTMLInputElement | HTMLTextAreaElement =>
  q<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${name}"]`);
const type = (name: string, value: string): void => {
  const el = field(name);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const click = (selector: string): void => q<HTMLElement>(selector).click();
const send = (): void => click('[data-action="send"]');
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  host()?.remove();
  document.documentElement.style.overflow = '';
  vi.restoreAllMocks();
});

describe('opening', () => {
  it('shows a modal dialog in a shadow root on a single host element', () => {
    const { show } = harness();
    void show();

    expect(host()).not.toBeNull();
    expect(document.querySelectorAll('[data-bugsee-report-dialog]')).toHaveLength(1);
    expect(host()?.parentElement).toBe(document.documentElement);
    expect(q<HTMLElement>('dialog').hasAttribute('open')).toBe(true);
    expect(q('[role="dialog"], dialog').getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('puts the dialog in the top layer with showModal when the browser has it', () => {
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    Object.defineProperty(HTMLElement.prototype, 'showModal', {
      configurable: true,
      value: showModal,
    });
    try {
      const { show } = harness();
      void show();

      expect(showModal).toHaveBeenCalledTimes(1);
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).showModal;
    }
  });

  it('falls back to a fixed full-viewport overlay at the highest z-index without showModal', () => {
    const { show } = harness();
    void show();

    const dialog = q<HTMLElement>('dialog');
    expect(dialog.getAttribute('open')).not.toBeNull();
    expect(dialog.getAttribute('data-fallback')).toBe('true');
    const css = root().querySelector('style')?.textContent ?? '';
    expect(css).toContain('position: fixed');
    expect(css).toContain('2147483647');
  });

  it('shades the page behind the card', () => {
    const { show } = harness();
    void show();

    const css = root().querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/\.overlay[^}]*background:\s*rgba\(0,\s*0,\s*0/);
  });

  it('focuses the summary field', () => {
    const { show } = harness();
    void show();

    expect(root().activeElement).toBe(field('summary'));
  });

  it('is a no-op that resolves null while the SDK is not launched', async () => {
    const { show } = harness({ isLaunched: () => false });

    expect(await show()).toBeNull();
    expect(host()).toBeNull();
  });

  it('refuses a second dialog while one is open, and allows one again after it closes', async () => {
    const { show } = harness();
    const first = show();

    expect(await show()).toBeNull();
    expect(document.querySelectorAll('[data-bugsee-report-dialog]')).toHaveLength(1);

    click('[data-action="cancel"]');
    expect(await first).toBeNull();

    void show();
    expect(host()).not.toBeNull();
  });

  it('locks page scrolling while open and restores it afterwards', async () => {
    document.documentElement.style.overflow = 'scroll';
    const { show } = harness();
    const pending = show();

    expect(document.documentElement.style.overflow).toBe('hidden');
    click('[data-action="cancel"]');
    await pending;

    expect(document.documentElement.style.overflow).toBe('scroll');
  });

  it('returns focus to the element that had it before the dialog opened', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const { show } = harness();
    const pending = show();

    click('[data-action="cancel"]');
    await pending;

    expect(document.activeElement).toBe(button);
  });
});

describe('layout', () => {
  it('lays the fields out in the mobile order: summary, description, then email', () => {
    const { show } = harness();
    void show();

    const order = [...root().querySelectorAll('[data-field]')].map((el) =>
      el.getAttribute('data-field'),
    );
    expect(order).toEqual(['summary', 'description', 'email']);
  });

  it('hides labels and the severity picker unless their options are on', () => {
    const { show } = harness();
    void show();

    expect(root().querySelector('[data-field="labels"]')).toBeNull();
    expect(root().querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('shows labels and the severity picker in order when enabled', () => {
    const { show } = harness({}, { labelsEnabled: true, prioritySelectorEnabled: true });
    void show();

    const order = [...root().querySelectorAll('[data-field], [role="radiogroup"]')].map(
      (el) => el.getAttribute('data-field') ?? el.getAttribute('role'),
    );
    expect(order).toEqual(['summary', 'description', 'radiogroup', 'labels', 'email']);
  });

  it('offers the five severities with the mobile labels', () => {
    const { show } = harness({}, { prioritySelectorEnabled: true });
    void show();

    const labels = [...root().querySelectorAll('[role="radiogroup"] label')].map((el) =>
      el.textContent?.trim(),
    );
    expect(labels).toEqual(['Low', 'Medium', 'High', 'Critical', 'Blocker']);
  });

  it('uses the mobile placeholders and gives every field a real label for assistive tech', () => {
    const { show } = harness({}, { labelsEnabled: true });
    void show();

    expect(field('summary').placeholder).toBe('Short summary');
    expect(field('description').placeholder).toBe('Bug description');
    expect(field('labels').placeholder).toBe('Labels');
    expect(field('email').placeholder).toBe('Reporter email');
    for (const name of ['summary', 'description', 'labels', 'email']) {
      const id = field(name).id;
      expect(root().querySelector(`label[for="${id}"]`), name).not.toBeNull();
    }
  });

  it('shows the SDK version in the footer', () => {
    const { show } = harness();
    void show();

    expect(q('[data-footer]').textContent).toBe('v0.1.0-test');
  });

  it('applies string overrides for localisation', () => {
    const { show } = harness();
    void show({ strings: { send: 'Absenden', summaryPlaceholder: 'Kurzfassung' } });

    expect(q('[data-action="send"]').textContent).toBe('Absenden');
    expect(field('summary').placeholder).toBe('Kurzfassung');
    expect(field('description').placeholder).toBe(
      DEFAULT_REPORT_DIALOG_STRINGS.descriptionPlaceholder,
    );
  });

  it('pins the colour scheme when asked, and follows the system otherwise', () => {
    const { show } = harness();
    void show({ theme: 'dark' });
    expect(host()?.getAttribute('data-theme')).toBe('dark');
    click('[data-action="cancel"]');

    void show();
    expect(host()?.getAttribute('data-theme')).toBe('auto');
  });
});

describe('prefill', () => {
  it('seeds the form from the options', () => {
    const { show } = harness({}, { labelsEnabled: true, prioritySelectorEnabled: true });
    void show({
      summary: 'Checkout broke',
      description: 'It spins',
      labels: ['a', 'b'],
      severity: 'critical',
    });

    expect(field('summary').value).toBe('Checkout broke');
    expect(field('description').value).toBe('It spins');
    expect(field('labels').value).toBe('a, b');
    expect(q<HTMLInputElement>('input[type="radio"]:checked').value).toBe('critical');
  });

  it('starts on the default bug priority', () => {
    const { show } = harness({}, { prioritySelectorEnabled: true, defaultSeverity: 'medium' });
    void show();

    expect(q<HTMLInputElement>('input[type="radio"]:checked').value).toBe('medium');
  });

  it('pre-fills the email from the stored user identifier', () => {
    const { show } = harness({ getUserIdentifier: () => 'jane@example.com' });
    void show();

    expect(field('email').value).toBe('jane@example.com');
  });

  it('shows pre-filled text as text, never as markup', () => {
    const { show } = harness();
    void show({ summary: '<img src=x onerror="window.__pwned=1">' });

    expect(root().querySelector('img')).toBeNull();
    expect(field('summary').value).toBe('<img src=x onerror="window.__pwned=1">');
  });
});

describe('validation', () => {
  it('shows an inline error and focuses the first invalid field instead of sending', async () => {
    const { show, upload } = harness(
      {},
      { summaryRequired: true, descriptionRequired: true, emailRequired: true },
    );
    void show();

    send();
    await settle();

    expect(upload).not.toHaveBeenCalled();
    expect(q('[data-error-for="summary"]').textContent).toBe('Summary is required');
    expect(q('[data-error-for="description"]').textContent).toBe('Description is required');
    expect(q('[data-error-for="email"]').textContent).toBe('Email is required');
    expect(root().activeElement).toBe(field('summary'));
    expect(field('summary').getAttribute('aria-invalid')).toBe('true');
  });

  it('requires labels only when they are both enabled and required', async () => {
    const { show, upload } = harness({}, { labelsEnabled: true, labelsRequired: true });
    void show();

    send();
    await settle();
    expect(q('[data-error-for="labels"]').textContent).toBe('Labels must be specified');
    expect(upload).not.toHaveBeenCalled();
  });

  it('does not require labels when the field is hidden', async () => {
    const { show, upload } = harness({}, { labelsEnabled: false, labelsRequired: true });
    void show();

    send();
    await settle();

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('treats whitespace as empty', async () => {
    const { show, upload } = harness({}, { summaryRequired: true });
    void show();
    type('summary', '   ');

    send();
    await settle();

    expect(upload).not.toHaveBeenCalled();
  });

  it('clears an error as soon as the field is corrected', async () => {
    const { show } = harness({}, { summaryRequired: true });
    void show();
    send();
    expect(q('[data-error-for="summary"]').textContent).toBe('Summary is required');

    type('summary', 'now filled');

    expect(q('[data-error-for="summary"]').textContent).toBe('');
    expect(field('summary').getAttribute('aria-invalid')).toBeNull();
  });

  it('rejects an email that is not an address, but accepts a blank optional one', async () => {
    const { show, upload } = harness();
    void show();
    type('email', 'not-an-address');

    send();
    await settle();
    expect(q('[data-error-for="email"]').textContent).toBe('Enter a valid email address');
    expect(upload).not.toHaveBeenCalled();

    type('email', '');
    send();
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe('sending', () => {
  it('uploads the form as a code_dialog report and resolves with the result', async () => {
    const { show, upload } = harness({}, { labelsEnabled: true, prioritySelectorEnabled: true });
    const pending = show();
    type('summary', '  Broken checkout ');
    type('description', ' It spins forever ');
    type('labels', 'checkout ,  payments,, ');
    type('email', ' jane@example.com ');
    q<HTMLInputElement>('input[type="radio"][value="blocker"]').click();

    send();

    expect(await pending).toEqual({ ok: true });
    expect(upload).toHaveBeenCalledWith({
      trigger: 'code_dialog',
      summary: 'Broken checkout',
      description: 'It spins forever',
      severity: 'blocker',
      labels: ['checkout', 'payments'],
      email: 'jane@example.com',
    });
    expect(host()).toBeNull();
  });

  it('sends the default priority when the picker is hidden, and omits empty fields', async () => {
    const { show, upload } = harness({}, { defaultSeverity: 'critical' });
    const pending = show();

    send();
    await pending;

    expect(upload).toHaveBeenCalledWith({
      trigger: 'code_dialog',
      severity: 'critical',
      labels: [],
    });
  });

  it('remembers a changed email as the user identifier', async () => {
    const { show, setUserIdentifier } = harness({ getUserIdentifier: () => 'old@example.com' });
    const pending = show();
    type('email', 'new@example.com');

    send();
    await pending;

    expect(setUserIdentifier).toHaveBeenCalledWith('new@example.com');
  });

  it('leaves the user identifier alone when the email did not change or is empty', async () => {
    const same = harness({ getUserIdentifier: () => 'same@example.com' });
    const first = same.show();
    send();
    await first;
    expect(same.setUserIdentifier).not.toHaveBeenCalled();

    const empty = harness();
    const second = empty.show();
    send();
    await second;
    expect(empty.setUserIdentifier).not.toHaveBeenCalled();
  });

  it('disables the form while sending and ignores a second click', async () => {
    let finish: (value: UploadResult) => void = () => {};
    const { show, upload } = harness();
    upload.mockImplementation(() => new Promise<UploadResult>((resolve) => (finish = resolve)));
    const pending = show();

    send();
    send();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(q<HTMLButtonElement>('[data-action="send"]').disabled).toBe(true);
    expect(field('summary').disabled).toBe(true);
    expect(q('[data-action="send"]').textContent).toBe('Sending…');

    finish({ ok: false });
    expect(await pending).toEqual({ ok: false });
  });

  it('closes and resolves a failed result rather than hanging when the upload throws', async () => {
    const { show, upload } = harness();
    upload.mockRejectedValue(new Error('boom'));
    const pending = show();

    send();

    expect(await pending).toEqual({ ok: false });
    expect(host()).toBeNull();
  });
});

describe('cancelling', () => {
  it('closes an untouched form at once and resolves null', async () => {
    const { show, upload } = harness();
    const pending = show();

    click('[data-action="cancel"]');

    expect(await pending).toBeNull();
    expect(host()).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it('asks before discarding a form that has been edited', async () => {
    const { show } = harness();
    const pending = show();
    type('summary', 'half written');

    click('[data-action="cancel"]');

    expect(host()).not.toBeNull();
    expect(q('[data-confirm]').hasAttribute('hidden')).toBe(false);
    expect(q('[data-confirm]').textContent).toContain(DEFAULT_REPORT_DIALOG_STRINGS.discardBody);
    expect(root().activeElement).toBe(q('[data-action="keep"]'));

    click('[data-action="keep"]');
    expect(q('[data-confirm]').hasAttribute('hidden')).toBe(true);
    expect(field('summary').value).toBe('half written');

    click('[data-action="cancel"]');
    click('[data-action="discard"]');
    expect(await pending).toBeNull();
    expect(host()).toBeNull();
  });

  it('does not count a pre-filled form as edited', async () => {
    const { show } = harness();
    const pending = show({ summary: 'seeded' });

    click('[data-action="cancel"]');

    expect(await pending).toBeNull();
    expect(host()).toBeNull();
  });

  it('treats Escape like the close button', async () => {
    const { show } = harness();
    const pending = show();
    const cancel = new Event('cancel', { cancelable: true });

    q('dialog').dispatchEvent(cancel);

    expect(cancel.defaultPrevented).toBe(true);
    expect(await pending).toBeNull();
  });

  it('treats a click on the shading as a cancel, but a click inside the card as nothing', async () => {
    const { show } = harness();
    const pending = show();

    q<HTMLElement>('form').click();
    expect(host()).not.toBeNull();

    q<HTMLElement>('dialog').click();
    expect(await pending).toBeNull();
    expect(host()).toBeNull();
  });
});

describe('edge behaviour', () => {
  it('treats Escape on the discard prompt as "keep editing"', async () => {
    const { show } = harness();
    const pending = show();
    type('summary', 'work in progress');
    click('[data-action="cancel"]');
    expect(q('[data-confirm]').hasAttribute('hidden')).toBe(false);

    q('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));

    expect(q('[data-confirm]').hasAttribute('hidden')).toBe(true);
    expect(host()).not.toBeNull();
    click('[data-action="cancel"]');
    click('[data-action="discard"]');
    await pending;
  });

  it('ignores cancel and a repeated submit while the report is being sent', async () => {
    let finish: (value: UploadResult) => void = () => {};
    const { show, upload } = harness();
    upload.mockImplementation(() => new Promise<UploadResult>((resolve) => (finish = resolve)));
    const pending = show();
    send();

    q('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));

    expect(host()).not.toBeNull();
    expect(upload).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    expect(await pending).toEqual({ ok: true });
  });

  it('closes with a failed result when upload throws synchronously', async () => {
    const { show, upload } = harness();
    upload.mockImplementation(() => {
      throw new Error('sync boom');
    });
    const pending = show();

    send();

    expect(await pending).toEqual({ ok: false });
    expect(host()).toBeNull();
  });

  it('resolves null instead of throwing into the page when the dialog cannot be built', async () => {
    const { show } = harness({
      document: {
        ...document,
        createElement: () => {
          throw new Error('no DOM');
        },
      } as unknown as Document,
    });

    expect(await show()).toBeNull();
    // ...and the failure did not leave the launcher locked.
    expect(await show()).toBeNull();
  });
});

describe('a stale dialog', () => {
  it('cannot unlock the launcher for, or close, the dialog that replaced it', async () => {
    const { show } = harness();
    const first = show();
    type('summary', 'a');
    click('[data-action="cancel"]');
    const discard = q<HTMLButtonElement>('[data-action="discard"]');
    discard.click();
    await first;

    const second = show();
    discard.click(); // the first dialog's button, now detached, clicked again

    expect(host()).not.toBeNull(); // the second dialog is still there
    expect(await show()).toBeNull(); // ...and the launcher still refuses a third
    click('[data-action="cancel"]');
    await second;
  });
});

describe('mutation-driven gaps', () => {
  it('moves focus to the first INVALID field, not just the first field', async () => {
    const { show } = harness({}, { emailRequired: true });
    void show();
    expect(root().activeElement).toBe(field('summary'));
    type('summary', 'ok');
    field('description').focus();

    send();
    await settle();

    expect(root().activeElement).toBe(field('email'));
  });

  it('still sends labels given to the call when the labels field is hidden', async () => {
    const { show, upload } = harness();
    const pending = show({ labels: ['seeded', 'kept'] });

    send();
    await pending;

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ labels: ['seeded', 'kept'] }));
  });
});
