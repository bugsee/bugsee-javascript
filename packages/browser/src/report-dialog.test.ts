// @vitest-environment jsdom
import {
  type InternalPreparedUpload,
  type InternalUploadOptions,
  LifecycleEvents,
  type UploadResult,
} from '@bugsee/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createReportDialogLauncher,
  parseSeverityName,
  type ReportDialogDeps,
  type ReportDialogUiOptions,
} from './report-dialog';
import { DEFAULT_REPORT_DIALOG_STRINGS } from './report-dialog-strings';
import { REPORT_DIALOG_CSS } from './report-dialog-styles';

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
  /** `InternalPreparedUpload.send` — what the dialog submits. */
  upload: ReturnType<typeof vi.fn<(options: InternalUploadOptions) => Promise<UploadResult>>>;
  discard: ReturnType<typeof vi.fn<() => void>>;
  prepare: ReturnType<typeof vi.fn<() => InternalPreparedUpload | null>>;
  setUserIdentifier: ReturnType<typeof vi.fn<(email: string) => void>>;
  clearUserIdentifier: ReturnType<typeof vi.fn<() => void>>;
  show: ReturnType<typeof createReportDialogLauncher>;
}

const harness = (
  overrides: Partial<ReportDialogDeps> = {},
  ui: Partial<ReportDialogUiOptions> = {},
): Harness => {
  const upload = vi.fn<(options: InternalUploadOptions) => Promise<UploadResult>>(async () => ({
    ok: true,
  }));
  const discard = vi.fn<() => void>();
  const prepare = vi.fn<() => InternalPreparedUpload | null>(() => ({ send: upload, discard }));
  const setUserIdentifier = vi.fn<(email: string) => void>();
  const clearUserIdentifier = vi.fn<() => void>();
  const deps: ReportDialogDeps = {
    document,
    prepare,
    isLaunched: () => true,
    getUserIdentifier: () => null,
    setUserIdentifier,
    clearUserIdentifier,
    sdkVersion: '0.1.0-test',
    ui: { ...UI, ...ui },
    ...overrides,
  };
  return {
    deps,
    upload,
    discard,
    prepare,
    setUserIdentifier,
    clearUserIdentifier,
    show: createReportDialogLauncher(deps),
  };
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
    expect(css).toMatch(
      /\.bugsee-reporting-dialog-overlay[^}]*background:\s*var\(--bugsee-reporting-dialog-shade\)/,
    );
    expect(css).toContain('--bugsee-reporting-dialog-shade: rgba(0, 0, 0');
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

  it('shows the send action as a paper-plane icon with an accessible name, not text', () => {
    const { show } = harness();
    void show();
    const send = q('[data-action="send"]');
    expect(send.textContent).toBe('');
    expect(send.getAttribute('aria-label')).toBe('Send');
    expect(send.getAttribute('title')).toBe('Send');
    const icon = send.querySelector('svg.bugsee-reporting-dialog-send-icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(20);
  });

  it('rounds the send arrowhead by stroking it with round joins', () => {
    expect(REPORT_DIALOG_CSS).toMatch(
      /send-icon \{[^}]*stroke: currentColor;[^}]*stroke-linejoin: round;/,
    );
  });

  it('uses the brand teal as the accent, with the AA variant on the light page', () => {
    const css = REPORT_DIALOG_CSS;
    expect(css).toContain('--bugsee-reporting-dialog-accent: #3A8A99');
    expect(css.match(/--bugsee-reporting-dialog-accent: #60B4C4/g)).toHaveLength(2); // dark + auto
    expect(css.toLowerCase()).not.toContain('#ff5858');
  });

  it('shows the SDK version in the footer', () => {
    const { show } = harness();
    void show();

    expect(q('[data-footer]').textContent).toBe('v0.1.0-test');
  });

  it('applies string overrides for localisation', () => {
    const { show } = harness();
    void show({ strings: { send: 'Absenden', summaryPlaceholder: 'Kurzfassung' } });

    expect(q('[data-action="send"]').getAttribute('aria-label')).toBe('Absenden');
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

  it("does not insist the email is an address — it is the app's user identifier (mobile parity)", async () => {
    const { show, upload } = harness();
    void show();
    type('email', 'user-42');

    send();
    await settle();

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ email: 'user-42' }));
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
    expect(q('[data-action="send"]').getAttribute('aria-label')).toBe('Sending…');

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

  it('resolves null instead of throwing into the page when the dialog cannot be built, and is not left locked', async () => {
    let broken = true;
    const real = document.createElement.bind(document);
    const { show, prepare, discard } = harness({
      document: {
        ...document,
        documentElement: document.documentElement,
        defaultView: window,
        activeElement: null,
        createElement: (tag: string) => {
          if (broken) throw new Error('no DOM');
          return real(tag);
        },
        createElementNS: document.createElementNS.bind(document),
        createTextNode: document.createTextNode.bind(document),
      } as unknown as Document,
    });

    expect(await show()).toBeNull();
    expect(discard).toHaveBeenCalledTimes(1); // the frozen capture is released, not leaked
    expect(host()).toBeNull();

    // The launcher was not left "open": once DOM works again the next call goes through.
    broken = false;
    void show();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(host()).not.toBeNull();
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

describe('powered-by link', () => {
  const link = (): HTMLAnchorElement => q<HTMLAnchorElement>('a[data-powered]');

  it('sizes the footer logo at 18px high and the "Powered by" text at 11px', () => {
    const rule = (cls: string): string =>
      REPORT_DIALOG_CSS.match(new RegExp(`\\.bugsee-reporting-dialog-${cls} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('logo')).toMatch(/height: 18px;/);
    expect(rule('logo')).not.toMatch(/height: 30px/);
    expect(rule('powered-text')).toMatch(/font-size: 11px;/);
  });

  it('shows the Bugsee logo with "Powered by Bugsee" at the bottom of the dialog', () => {
    const { show } = harness();
    void show();

    expect(link().textContent?.trim()).toBe('Powered by Bugsee');
    const logo = link().querySelector('svg');
    expect(logo).not.toBeNull();
    expect(logo?.getAttribute('viewBox')).toBe('0 0 495 252');
    expect(logo?.getAttribute('aria-hidden')).toBe('true');
    // the brand mark, not a placeholder: its red body and white eye
    expect(logo?.querySelector('path')?.parentElement?.getAttribute('fill')).toBe('#ff5858');
    expect(logo?.querySelector('ellipse')?.getAttribute('fill')).toBe('#fff');
    // bottom of the card: after every field, and after the version line
    const after = (a: Element, b: Element): boolean =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(field('email'), link())).toBe(true);
    expect(after(q('[data-footer]'), link())).toBe(true);
  });

  it('opens bugsee.com in a new tab that has no opener and sends no referrer', () => {
    const { show } = harness();
    void show();

    expect(link().getAttribute('href')).toBe('https://bugsee.com');
    expect(link().getAttribute('target')).toBe('_blank');
    const rel = (link().getAttribute('rel') ?? '').split(/\s+/);
    expect(rel).toContain('noopener'); // the new page gets no window.opener
    expect(rel).toContain('noreferrer'); // ...and no Referer: the page URL stays private
  });

  it('is reached by keyboard like any link, and a click on it does not cancel the dialog', () => {
    const { show } = harness();
    void show();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link().addEventListener('click', (event) => event.preventDefault()); // do not navigate in jsdom

    link().dispatchEvent(click);

    expect(host()).not.toBeNull();
    expect(link().tabIndex).toBe(0);
  });

  it('follows the strings override', () => {
    const { show } = harness();
    void show({ strings: { poweredBy: 'Bereitgestellt von Bugsee' } });

    expect(link().textContent?.trim()).toBe('Bereitgestellt von Bugsee');
  });
});

describe('the report is prepared when the dialog opens', () => {
  it('freezes the capture before any UI exists, and sends from that same handle', async () => {
    const { show, prepare, upload } = harness();
    const pending = show();

    expect(prepare).toHaveBeenCalledTimes(1);
    send();
    await pending;

    expect(prepare).toHaveBeenCalledTimes(1); // Send does not prepare again
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('resolves null and shows nothing when the client cannot prepare (stopped/killed)', async () => {
    const { show } = harness({ prepare: () => null });

    expect(await show()).toBeNull();
    expect(host()).toBeNull();
  });

  it('releases the frozen capture when the user cancels or discards, but not when they send', async () => {
    const cancelled = harness();
    const first = cancelled.show();
    click('[data-action="cancel"]');
    await first;
    expect(cancelled.discard).toHaveBeenCalledTimes(1);

    const sent = harness();
    const second = sent.show();
    send();
    await second;
    expect(sent.discard).not.toHaveBeenCalled();
  });
});

describe('the browser closing the dialog itself', () => {
  it('cleans up on the native close event: host gone, scroll restored, launcher free again', async () => {
    document.documentElement.style.overflow = 'scroll';
    const { show, discard } = harness();
    const pending = show();

    q('dialog').dispatchEvent(new Event('close'));

    expect(await pending).toBeNull();
    expect(host()).toBeNull();
    expect(document.documentElement.style.overflow).toBe('scroll');
    expect(discard).toHaveBeenCalledTimes(1);
    void show();
    expect(host()).not.toBeNull(); // not dead until reload
  });

  it('leaves a non-cancellable cancel (a second Escape) to the browser instead of fighting it', () => {
    const { show } = harness();
    void show();
    type('summary', 'edited');
    const cancel = new Event('cancel', { cancelable: false });

    q('dialog').dispatchEvent(cancel);

    expect(host()).not.toBeNull(); // no discard prompt either: the close event cleans up
    expect(q('[data-confirm]').hasAttribute('hidden')).toBe(true);
  });

  it('leaves no host element and no scroll lock when showModal throws', async () => {
    Object.defineProperty(HTMLElement.prototype, 'showModal', {
      configurable: true,
      value: () => {
        throw new Error('InvalidStateError');
      },
    });
    try {
      document.documentElement.style.overflow = 'auto';
      const { show } = harness();

      expect(await show()).toBeNull();
      expect(host()).toBeNull();
      expect(document.documentElement.style.overflow).toBe('auto');
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).showModal;
    }
  });
});

describe('the reporter email', () => {
  it('clears the stored identifier when the user erases it, and sends no email', async () => {
    const { show, upload, clearUserIdentifier, setUserIdentifier } = harness({
      getUserIdentifier: () => 'jane@example.com',
    });
    const pending = show();
    type('email', '');

    send();
    await pending;

    expect(clearUserIdentifier).toHaveBeenCalledTimes(1);
    expect(setUserIdentifier).not.toHaveBeenCalled();
    expect(upload.mock.calls[0]?.[0]).not.toHaveProperty('email');
  });

  it('does not touch the identifier when it was empty and still is', async () => {
    const { show, clearUserIdentifier } = harness();
    const pending = show();

    send();
    await pending;

    expect(clearUserIdentifier).not.toHaveBeenCalled();
  });
});

describe('severity input', () => {
  it('accepts the canonical names, forgiving case and space, and nothing else', () => {
    expect(parseSeverityName('Critical')).toBe('critical');
    expect(parseSeverityName('  blocker ')).toBe('blocker');
    expect(parseSeverityName('verylow')).toBe('verylow');
    expect(parseSeverityName('urgent')).toBeUndefined();
    expect(parseSeverityName(3)).toBeUndefined();
    expect(parseSeverityName(undefined)).toBeUndefined();
  });

  it('falls back to the default when a per-call severity is invalid, and still checks a radio', async () => {
    const { show, upload } = harness(
      {},
      { prioritySelectorEnabled: true, defaultSeverity: 'medium' },
    );
    const pending = show({ severity: 'urgent' as unknown as 'high' });

    expect(q<HTMLInputElement>('input[type="radio"]:checked').value).toBe('medium');
    send();
    await pending;
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ severity: 'medium' }));
  });
});

describe('the Enter key', () => {
  const enter = (name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...init,
    });
    field(name).dispatchEvent(event);
    return event;
  };

  it('moves from the summary to the next field instead of sending a half-written report', async () => {
    const { show, upload } = harness();
    void show();
    type('summary', 'halfway');

    const event = enter('summary');
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(root().activeElement).toBe(field('description'));
  });

  it('leaves Enter in the multi-line description alone (it is a newline)', () => {
    const { show } = harness();
    void show();

    expect(enter('description').defaultPrevented).toBe(false);
  });

  it('sends from the last field', async () => {
    const { show, upload } = harness();
    const pending = show();

    enter('email');
    await pending;

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('ignores an Enter that confirms an IME composition', () => {
    const { show, upload } = harness();
    void show();

    const event = enter('summary', { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(root().activeElement).toBe(field('summary'));
  });

  it('ignores other keys', () => {
    const { show } = harness();
    void show();
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });

    field('summary').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('styling hooks for embedders', () => {
  const prefix = 'bugsee-reporting-dialog-';

  it('prefixes every class, and exposes each one as a part of the same name', () => {
    const { show } = harness({}, { labelsEnabled: true, prioritySelectorEnabled: true });
    void show();

    const classed = [...root().querySelectorAll('[class]')];
    expect(classed.length).toBeGreaterThan(20);
    for (const element of classed) {
      const tokens = (element.getAttribute('class') ?? '').split(/\s+/);
      expect(
        tokens.every((token) => token.startsWith(prefix)),
        `${element.tagName}.${tokens.join('.')}`,
      ).toBe(true);
      expect(element.getAttribute('part'), element.tagName).toBe(element.getAttribute('class'));
    }
  });

  it('puts the root class on the host and prefixes the custom properties', () => {
    const { show } = harness();
    void show();

    expect(host()?.getAttribute('class')).toBe('bugsee-reporting-dialog');
    const css = root().querySelector('style')?.textContent ?? '';
    // every custom property is namespaced, so a page can set them and nothing else collides
    const properties = [...css.matchAll(/--([a-z-]+):/g)].map((m) => m[1] as string);
    expect(properties.length).toBeGreaterThan(8);
    expect(properties.every((name) => name.startsWith(prefix))).toBe(true);
    // and no un-prefixed class selector survives in the built-in stylesheet
    expect(css).not.toMatch(/(^|[\s,}])\.(?!bugsee-reporting-dialog-)[a-z]/m);
  });

  it('names the main parts an embedder will want', () => {
    const { show } = harness({}, { prioritySelectorEnabled: true, labelsEnabled: true });
    void show();

    for (const part of [
      'overlay',
      'card',
      'bar',
      'title',
      'send',
      'close',
      'body',
      'input-summary',
      'input-description',
      'input-email',
      'input-labels',
      'row-summary',
      'error',
      'severity',
      'severity-option',
      'severity-critical',
      'powered',
      'logo',
      'footer-row',
      'version',
      'confirm',
      'confirm-keep',
      'confirm-discard',
    ]) {
      expect(root().querySelector(`[part~="${prefix}${part}"]`), part).not.toBeNull();
    }
  });

  it('appends the css option inside the shadow root, after the built-in styles', () => {
    const { show } = harness();
    void show({ css: '.bugsee-reporting-dialog-send { color: navy; }' });

    const styles = [...root().querySelectorAll('style')].map((el) => el.textContent ?? '');
    expect(styles).toHaveLength(2);
    expect(styles[1]).toBe('.bugsee-reporting-dialog-send { color: navy; }');
  });

  it('adds nothing for an empty css option', () => {
    const { show } = harness();
    void show({ css: '' });

    expect(root().querySelectorAll('style')).toHaveLength(1);
  });

  it('uses constructable stylesheets when available, so a strict style-src CSP cannot blank it', () => {
    const adopted: string[] = [];
    class FakeSheet {
      replaceSync(css: string): void {
        adopted.push(css);
      }
    }
    const sheet = window as unknown as { CSSStyleSheet: unknown };
    const original = sheet.CSSStyleSheet;
    sheet.CSSStyleSheet = FakeSheet;
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
      configurable: true,
      writable: true,
      value: [],
    });
    try {
      const { show } = harness();
      void show({ css: '.x { color: red; }' });

      expect(adopted).toHaveLength(2);
      expect(adopted[0]).toContain('.bugsee-reporting-dialog-card');
      expect(adopted[1]).toBe('.x { color: red; }');
      expect(root().querySelectorAll('style')).toHaveLength(0); // nothing for the CSP to block
    } finally {
      sheet.CSSStyleSheet = original;
      delete (ShadowRoot.prototype as unknown as Record<string, unknown>).adoptedStyleSheets;
    }
  });

  it('falls back to <style> elements when adopting a stylesheet throws', () => {
    class ThrowingSheet {
      replaceSync(): void {
        throw new Error('SecurityError');
      }
    }
    const sheet = window as unknown as { CSSStyleSheet: unknown };
    const original = sheet.CSSStyleSheet;
    sheet.CSSStyleSheet = ThrowingSheet;
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
      configurable: true,
      writable: true,
      value: [],
    });
    try {
      const { show } = harness();
      void show();

      expect(root().querySelectorAll('style')).toHaveLength(1);
    } finally {
      sheet.CSSStyleSheet = original;
      delete (ShadowRoot.prototype as unknown as Record<string, unknown>).adoptedStyleSheets;
    }
  });
});

describe('strings overrides', () => {
  it('ignores a non-string override instead of printing "undefined"', () => {
    const { show } = harness();
    void show({
      strings: { summaryPlaceholder: undefined } as unknown as { summaryPlaceholder: string },
    });

    expect(field('summary').placeholder).toBe('Short summary');
  });
});

describe('lifecycle events', () => {
  it('announces BeforeReportShown when the dialog opens and AfterReportShown once it is gone', async () => {
    const emit = vi.fn();
    const { show } = harness({ emitLifecycleEvent: emit });
    const pending = show();

    expect(emit.mock.calls).toEqual([[LifecycleEvents.BeforeReportShown]]);
    expect(host()).not.toBeNull(); // Before fired as the dialog went up, not after it was dismissed

    send();
    await pending;
    expect(emit.mock.calls).toEqual([
      [LifecycleEvents.BeforeReportShown],
      [LifecycleEvents.AfterReportShown, { sent: true }],
    ]);
  });

  it('announces AfterReportShown with sent:false when the user discards', async () => {
    const emit = vi.fn();
    const { show } = harness({ emitLifecycleEvent: emit });
    const pending = show();
    click('[data-action="cancel"]');
    await pending;

    expect(emit).toHaveBeenLastCalledWith(LifecycleEvents.AfterReportShown, { sent: false });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('announces AfterReportShown only once the dialog is really gone from the page', async () => {
    const hostAtAfter: Array<HTMLElement | null> = [];
    const emit = vi.fn((type: string) => {
      if (type === LifecycleEvents.AfterReportShown) hostAtAfter.push(host());
    });
    const { show } = harness({ emitLifecycleEvent: emit });
    const pending = show();
    send();
    await pending;
    expect(hostAtAfter).toEqual([null]);
  });

  it('reports sent:false when the send came back refused, or threw', async () => {
    for (const failure of [
      async () => ({ ok: false }) as UploadResult,
      async () => {
        throw new Error('boom');
      },
    ]) {
      const emit = vi.fn();
      const h = harness({ emitLifecycleEvent: emit });
      h.upload.mockImplementation(failure);
      const pending = h.show();
      send();
      await pending;
      expect(emit).toHaveBeenLastCalledWith(LifecycleEvents.AfterReportShown, { sent: false });
    }
  });

  it('still settles when the lifecycle hook throws', async () => {
    const { show } = harness({
      emitLifecycleEvent: (type) => {
        if (type === LifecycleEvents.AfterReportShown) throw new Error('hook');
      },
    });
    const pending = show();
    send();
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('announces nothing when no dialog is shown (cannot prepare, or SDK not running)', async () => {
    const emit = vi.fn();
    await harness({ emitLifecycleEvent: emit, prepare: () => null }).show();
    await harness({ emitLifecycleEvent: emit, isLaunched: () => false }).show();
    expect(emit).not.toHaveBeenCalled();
  });

  it('works without a lifecycle hook', async () => {
    const { show } = harness();
    const pending = show();
    send();
    await expect(pending).resolves.toEqual({ ok: true });
  });
});

describe('toolbar buttons', () => {
  it('give the close and send actions the same button size', () => {
    const css = REPORT_DIALOG_CSS;
    const box = (name: string): string => {
      const rule = css.match(new RegExp(`\\.bugsee-reporting-dialog-${name} \\{([^}]*)\\}`));
      return `${rule?.[1]?.match(/width: (\d+px)/)?.[1]}x${rule?.[1]?.match(/height: (\d+px)/)?.[1]}`;
    };
    expect(box('send')).toBe('44pxx44px');
    expect(box('close')).toBe(box('send'));
  });
});

describe('version line', () => {
  it('is small and faint next to the "Powered by" text', () => {
    const rule =
      REPORT_DIALOG_CSS.match(/\.bugsee-reporting-dialog-version \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('font-size: 9px');
    expect(rule).toContain('opacity: 0.3');
  });
});

describe('page shading', () => {
  it('is nearly black, so the page behind the dialog is barely visible', () => {
    const alpha = REPORT_DIALOG_CSS.match(
      /--bugsee-reporting-dialog-shade: rgba\(0, 0, 0, ([\d.]+)\)/,
    )?.[1];
    expect(Number(alpha)).toBeGreaterThanOrEqual(0.9);
  });
});
