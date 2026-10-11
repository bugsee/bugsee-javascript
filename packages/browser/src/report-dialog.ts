import type { UploadOptions, UploadResult } from '@bugsee/core';
import { DEFAULT_REPORT_DIALOG_STRINGS, type ReportDialogStrings } from './report-dialog-strings';
import { REPORT_DIALOG_CSS } from './report-dialog-styles';

// The browser's `showReportDialog()` — the web counterpart of the mobile SDKs' report form (Android
// `BugReportingActivity`, iOS `BGSReportController`). Same fields, order, strings and validation; shown
// as a modal over a shaded page rather than full screen. Design: docs/design/report-dialog.md.
//
// Hard rules this file keeps:
//   - the UI lives in ONE shadow root on ONE host element, so page CSS cannot restyle it;
//   - it is built with DOM APIs only, so user text is never parsed as HTML;
//   - it sits in the TOP LAYER (`<dialog>.showModal()`), above every z-index and above any modal the page
//     already has open; the fixed/max-z-index fallback exists only for browsers without `showModal`;
//   - it never throws into the host page: a dialog that cannot be built resolves `null`.

/** A severity by name; `low` and `verylow` are the same wire value. */
export type SeverityName = NonNullable<UploadOptions['severity']>;

export type { ReportDialogStrings } from './report-dialog-strings';
export { DEFAULT_REPORT_DIALOG_STRINGS } from './report-dialog-strings';

/** The dialog severities, in display order (the five mobile picker entries). */
const SEVERITIES = ['low', 'medium', 'high', 'critical', 'blocker'] as const;
type PickerSeverity = (typeof SEVERITIES)[number];

/** Per-call options of {@link createReportDialogLauncher}'s function — `client.showReportDialog(options)`. */
export interface ReportDialogOptions {
  /** Pre-fill the summary. */
  summary?: string;
  /** Pre-fill the description. */
  description?: string;
  /** Pre-select a severity (otherwise the `reportDefaultBugPriority` launch option, `high`). */
  severity?: SeverityName;
  /** Pre-fill the labels. */
  labels?: string[];
  /** Override any user-facing string — the localisation seam. */
  strings?: Partial<ReportDialogStrings>;
  /** `auto` follows the system colour scheme (default); `light` / `dark` pin it. */
  theme?: 'auto' | 'light' | 'dark';
}

/** The reporting-UI launch options, resolved (see `reportSummaryRequired` … `reportDefaultBugPriority`). */
export interface ReportDialogUiOptions {
  summaryRequired: boolean;
  descriptionRequired: boolean;
  emailRequired: boolean;
  labelsEnabled: boolean;
  labelsRequired: boolean;
  prioritySelectorEnabled: boolean;
  defaultSeverity: SeverityName;
}

/** What the dialog needs from the client and the page — injected so it is testable without either. */
export interface ReportDialogDeps {
  document: Document;
  /** Submit the report (`client.upload`). */
  upload(options: UploadOptions): Promise<UploadResult>;
  /** The dialog does nothing, as on mobile, while the SDK is not running. */
  isLaunched(): boolean;
  getUserIdentifier(): string | null;
  setUserIdentifier(email: string): void;
  /** Shown in the footer as `v<sdkVersion>`. */
  sdkVersion: string;
  ui: ReportDialogUiOptions;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// Material "bug_report" and "close" glyphs (Apache-2.0).
const BUG_PATH =
  'M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a6.002 6.002 0 0 0-2.83 0L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z';
const CLOSE_PATH =
  'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

// The Bugsee mark (brand red body, white eye) — the same artwork as the viewer's logo.svg.
const LOGO_BODY =
  'm102 251.9h30.4v-31h10v31.1h30.4v-31h40v31.1h30.4v-31h10v31.1h33.7c-2.8-9.2-4.3-19-4.3-29.1 0-55.4 45.2-100.4 100.9-100.4 40.6 0 75.6 23.9 91.6 58.3h19.1c-17.6-59.2-56.5-109.3-108-141.4 1.7-7.8.2-15.9-3.9-22.6-7.7.3-15.1 3.5-20.6 9.1-33.1-15.9-70.2-24.8-109.5-24.8-139.3 0-252.3 112.3-252.3 250.9h82v-31h20v31.1zm240-149.5c13.9 0 25.2-11.2 25.2-25.1s-11.3-25.1-25.2-25.1-25.2 11.2-25.2 25.1 11.3 25.1 25.2 25.1zm9.1-7c5.6 0 10.1-4.5 10.1-10s-4.5-10-10.1-10-10.1 4.5-10.1 10 4.5 10 10.1 10zm-20.7-43.3';
const LOGO_HORN =
  'm330.4 52.1c9.6-4.1 16.9-13 18.2-24.1s-3.5-21.5-11.9-27.8c-9.6 4.1-16.9 13-18.2 24.1s3.5 21.5 11.9 27.8z';
const BUGSEE_URL = 'https://bugsee.com';

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

/** A severity the picker can show; `verylow` is the same wire value as `low`. */
const pickerSeverity = (name: SeverityName): PickerSeverity => (name === 'verylow' ? 'low' : name);

type FieldName = 'summary' | 'description' | 'labels' | 'email';

export type ReportDialogLauncher = (options?: ReportDialogOptions) => Promise<UploadResult | null>;

/**
 * Build the `showReportDialog` function for a client. At most one dialog is open at a time: while one
 * is, further calls resolve `null` at once (Android: "does nothing if a dialog is already shown").
 */
export function createReportDialogLauncher(deps: ReportDialogDeps): ReportDialogLauncher {
  let open = false;

  return (options: ReportDialogOptions = {}): Promise<UploadResult | null> => {
    if (open || !deps.isLaunched()) {
      return Promise.resolve(null);
    }
    open = true;
    return new Promise<UploadResult | null>((resolve) => {
      const finish = (result: UploadResult | null): void => {
        open = false;
        resolve(result);
      };
      try {
        showDialog(deps, options, finish);
      } catch {
        // Building UI must never throw into the host application.
        finish(null);
      }
    });
  };
}

interface Refs {
  host: HTMLElement;
  dialog: HTMLElement;
  form: HTMLFormElement;
  send: HTMLButtonElement;
  close: HTMLButtonElement;
  confirm: HTMLElement;
  keep: HTMLButtonElement;
  fields: Partial<Record<FieldName, HTMLInputElement | HTMLTextAreaElement>>;
  errors: Partial<Record<FieldName, HTMLElement>>;
  radios: HTMLInputElement[];
}

function showDialog(
  deps: ReportDialogDeps,
  options: ReportDialogOptions,
  finish: (result: UploadResult | null) => void,
): void {
  const { document: doc, ui } = deps;
  const strings: ReportDialogStrings = { ...DEFAULT_REPORT_DIALOG_STRINGS, ...options.strings };
  const initialEmail = deps.getUserIdentifier() ?? '';
  const initialSeverity = pickerSeverity(options.severity ?? ui.defaultSeverity);
  const refs = build(doc, strings, ui, options, initialEmail, initialSeverity, deps.sdkVersion);

  const previousFocus = doc.activeElement as HTMLElement | null;
  const previousOverflow = doc.documentElement.style.overflow;
  let busy = false;
  let closed = false;

  const fieldValue = (name: FieldName): string => refs.fields[name]?.value.trim() ?? '';
  const severityValue = (): PickerSeverity =>
    (refs.radios.find((radio) => radio.checked)?.value as PickerSeverity | undefined) ??
    initialSeverity;
  const snapshot = (): string =>
    JSON.stringify([
      refs.fields.summary?.value,
      refs.fields.description?.value,
      refs.fields.labels?.value,
      refs.fields.email?.value,
      severityValue(),
    ]);
  const pristine = snapshot();

  const closeDialog = (result: UploadResult | null): void => {
    if (closed) {
      return;
    }
    closed = true;
    refs.host.remove();
    doc.documentElement.style.overflow = previousOverflow;
    try {
      previousFocus?.focus?.();
    } catch {
      // a focus target that went away is not worth failing the close for
    }
    finish(result);
  };

  const setBusy = (value: boolean): void => {
    busy = value;
    refs.send.disabled = value;
    refs.send.textContent = value ? strings.sending : strings.send;
    for (const control of Object.values(refs.fields)) {
      control.disabled = value;
    }
    for (const radio of refs.radios) {
      radio.disabled = value;
    }
    refs.close.disabled = value;
  };

  const showConfirm = (visible: boolean): void => {
    if (visible) {
      refs.confirm.removeAttribute('hidden');
      refs.keep.focus();
    } else {
      refs.confirm.setAttribute('hidden', '');
      (refs.fields.summary ?? refs.send).focus();
    }
  };

  const requestCancel = (): void => {
    if (busy) {
      return;
    }
    if (!refs.confirm.hasAttribute('hidden')) {
      showConfirm(false); // Escape on the confirmation means "keep editing"
      return;
    }
    if (snapshot() === pristine) {
      closeDialog(null);
      return;
    }
    showConfirm(true);
  };

  const setError = (name: FieldName, message: string): void => {
    const error = refs.errors[name];
    const field = refs.fields[name];
    if (!error || !field) {
      return;
    }
    error.textContent = message;
    if (message === '') {
      field.removeAttribute('aria-invalid');
    } else {
      field.setAttribute('aria-invalid', 'true');
    }
  };

  /** The first message per field, in display order; empty when the form can be sent. */
  const validate = (): Array<[FieldName, string]> => {
    const problems: Array<[FieldName, string]> = [];
    if (ui.summaryRequired && fieldValue('summary') === '') {
      problems.push(['summary', strings.summaryRequired]);
    }
    if (ui.descriptionRequired && fieldValue('description') === '') {
      problems.push(['description', strings.descriptionRequired]);
    }
    if (ui.labelsEnabled && ui.labelsRequired && parseLabels(fieldValue('labels')).length === 0) {
      problems.push(['labels', strings.labelsRequired]);
    }
    const email = fieldValue('email');
    if (email === '' && ui.emailRequired) {
      problems.push(['email', strings.emailRequired]);
    } else if (email !== '' && !EMAIL_PATTERN.test(email)) {
      problems.push(['email', strings.emailInvalid]);
    }
    return problems;
  };

  const submit = (): void => {
    if (busy || closed) {
      return;
    }
    for (const name of ['summary', 'description', 'labels', 'email'] as const) {
      setError(name, '');
    }
    const problems = validate();
    if (problems.length > 0) {
      for (const [name, message] of problems) {
        setError(name, message);
      }
      refs.fields[problems[0]?.[0] as FieldName]?.focus();
      return;
    }

    const summary = fieldValue('summary');
    const description = fieldValue('description');
    const email = fieldValue('email');
    const labels = ui.labelsEnabled ? parseLabels(fieldValue('labels')) : (options.labels ?? []);
    const severity: SeverityName = ui.prioritySelectorEnabled
      ? severityValue()
      : (options.severity ?? ui.defaultSeverity);

    if (email !== '' && email !== initialEmail) {
      deps.setUserIdentifier(email);
    }
    setBusy(true);
    let sent: Promise<UploadResult>;
    try {
      sent = deps.upload({
        trigger: 'code_dialog',
        ...(summary !== '' ? { summary } : {}),
        ...(description !== '' ? { description } : {}),
        severity,
        labels,
        ...(email !== '' ? { email } : {}),
      });
    } catch {
      sent = Promise.resolve({ ok: false });
    }
    sent.then(
      (result) => closeDialog(result),
      () => closeDialog({ ok: false }),
    );
  };

  refs.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  refs.close.addEventListener('click', requestCancel);
  refs.keep.addEventListener('click', () => showConfirm(false));
  refs.confirm
    .querySelector('[data-action="discard"]')
    ?.addEventListener('click', () => closeDialog(null));
  // Escape: the browser would close a modal dialog on its own, discarding the form silently.
  refs.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    requestCancel();
  });
  // A click on the shading (the dialog element itself, not the card) is a cancel; clicks inside the card
  // have the card's descendants as their target.
  refs.dialog.addEventListener('click', (event) => {
    if (event.target === refs.dialog) {
      requestCancel();
    }
  });
  for (const name of Object.keys(refs.fields) as FieldName[]) {
    refs.fields[name]?.addEventListener('input', () => setError(name, ''));
  }

  doc.documentElement.append(refs.host);
  doc.documentElement.style.overflow = 'hidden';
  const dialog = refs.dialog as HTMLDialogElement;
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    refs.dialog.setAttribute('data-fallback', 'true');
    refs.dialog.setAttribute('open', '');
  }
  refs.fields.summary?.focus();
}

const parseLabels = (text: string): string[] =>
  text
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '');

// ---- DOM construction --------------------------------------------------------------------------

function build(
  doc: Document,
  strings: ReportDialogStrings,
  ui: ReportDialogUiOptions,
  options: ReportDialogOptions,
  initialEmail: string,
  initialSeverity: PickerSeverity,
  sdkVersion: string,
): Refs {
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Record<string, string> = {},
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, value);
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  };
  const icon = (path: string): SVGElement => {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const shape = doc.createElementNS(SVG_NS, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    return svg;
  };

  const host = make('div', {
    'data-bugsee-report-dialog': '',
    'data-theme': options.theme ?? 'auto',
  });
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(make('style', {}, REPORT_DIALOG_CSS));

  const titleId = 'bugsee-report-title';
  const dialog = make('dialog', { class: 'overlay', 'aria-labelledby': titleId });
  const form = make('form', { class: 'card', novalidate: '' });

  const close = make('button', { type: 'button', class: 'close', 'aria-label': strings.close });
  close.setAttribute('data-action', 'cancel');
  close.append(icon(CLOSE_PATH));
  const send = make('button', { type: 'submit', class: 'send' }, strings.send);
  send.setAttribute('data-action', 'send');
  const bar = make('div', { class: 'bar' });
  bar.append(close, make('h2', { id: titleId, class: 'title' }, strings.title), send);

  const body = make('div', { class: 'body' });
  const fields: Refs['fields'] = {};
  const errors: Refs['errors'] = {};

  const addField = (
    name: FieldName,
    control: HTMLInputElement | HTMLTextAreaElement,
    placeholder: string,
    value: string,
  ): void => {
    const id = `bugsee-report-${name}`;
    control.id = id;
    control.setAttribute('data-field', name);
    control.setAttribute('class', 'input');
    control.setAttribute('placeholder', placeholder);
    control.setAttribute('aria-describedby', `${id}-error`);
    control.value = value;
    const label = make('label', { for: id, class: 'sr-only' }, placeholder);
    const error = make('p', { id: `${id}-error`, class: 'error', 'aria-live': 'polite' });
    error.setAttribute('data-error-for', name);
    const row = make('div', { class: 'row' });
    row.append(label, control, error);
    body.append(row);
    fields[name] = control;
    errors[name] = error;
  };

  addField(
    'summary',
    make('input', { type: 'text', autocomplete: 'off' }),
    strings.summaryPlaceholder,
    options.summary ?? '',
  );
  addField(
    'description',
    make('textarea', { rows: '5' }),
    strings.descriptionPlaceholder,
    options.description ?? '',
  );

  const radios: HTMLInputElement[] = [];
  if (ui.prioritySelectorEnabled) {
    const group = make('div', {
      class: 'severity',
      role: 'radiogroup',
      'aria-label': strings.severityLegend,
    });
    const names: Record<PickerSeverity, string> = {
      low: strings.severityLow,
      medium: strings.severityMedium,
      high: strings.severityHigh,
      critical: strings.severityCritical,
      blocker: strings.severityBlocker,
    };
    for (const severity of SEVERITIES) {
      const radio = make('input', {
        type: 'radio',
        name: 'bugsee-report-severity',
        value: severity,
        class: 'sr-only',
      });
      radio.checked = severity === initialSeverity;
      radios.push(radio);
      const label = make('label', { class: `sev-${severity}` });
      label.append(radio, icon(BUG_PATH), doc.createTextNode(names[severity]));
      group.append(label);
    }
    body.append(group);
  }

  if (ui.labelsEnabled) {
    addField(
      'labels',
      make('input', { type: 'text', autocomplete: 'off' }),
      strings.labelsPlaceholder,
      (options.labels ?? []).join(', '),
    );
  }
  addField(
    'email',
    make('input', { type: 'email', autocomplete: 'email', inputmode: 'email' }),
    strings.emailPlaceholder,
    initialEmail,
  );

  const footer = make('p', { class: 'footer' }, `v${sdkVersion}`);
  footer.setAttribute('data-footer', '');

  // "Powered by Bugsee": opens bugsee.com in a NEW tab that gets no `window.opener` (noopener) and no
  // Referer (noreferrer — the host page's URL can carry tokens or ids and must not leak to us).
  const logo = doc.createElementNS(SVG_NS, 'svg');
  logo.setAttribute('viewBox', '0 0 495 252');
  logo.setAttribute('aria-hidden', 'true');
  const mark = doc.createElementNS(SVG_NS, 'g');
  mark.setAttribute('fill-rule', 'evenodd');
  const eye = doc.createElementNS(SVG_NS, 'ellipse');
  for (const [name, value] of Object.entries({
    cx: '341.766',
    cy: '77.303',
    rx: '30.315',
    ry: '30.522',
    fill: '#fff',
  })) {
    eye.setAttribute(name, value);
  }
  const brand = doc.createElementNS(SVG_NS, 'g');
  brand.setAttribute('fill', '#ff5858');
  for (const d of [LOGO_BODY, LOGO_HORN]) {
    const shape = doc.createElementNS(SVG_NS, 'path');
    shape.setAttribute('d', d);
    brand.append(shape);
  }
  mark.append(eye, brand);
  logo.append(mark);
  const powered = make('a', {
    class: 'powered',
    href: BUGSEE_URL,
    target: '_blank',
    rel: 'noopener noreferrer',
  });
  powered.setAttribute('data-powered', '');
  powered.append(logo, doc.createTextNode(strings.poweredBy));
  const footerRow = make('div', { class: 'footer-row' });
  footerRow.append(footer, powered);

  const confirm = make('div', {
    class: 'confirm',
    role: 'alertdialog',
    'aria-labelledby': 'bugsee-report-discard',
    hidden: '',
  });
  confirm.setAttribute('data-confirm', '');
  const keep = make('button', { type: 'button' }, strings.discardKeep);
  keep.setAttribute('data-action', 'keep');
  const discard = make('button', { type: 'button', class: 'danger' }, strings.discardConfirm);
  discard.setAttribute('data-action', 'discard');
  const actions = make('div', { class: 'confirm-actions' });
  actions.append(keep, discard);
  confirm.append(
    make('h3', { id: 'bugsee-report-discard' }, strings.discardTitle),
    make('p', {}, strings.discardBody),
    actions,
  );

  form.append(bar, body, footerRow, confirm);
  dialog.append(form);
  shadow.append(dialog);

  return {
    host,
    dialog,
    form,
    send,
    close,
    confirm,
    keep,
    fields: fields as Refs['fields'],
    errors,
    radios,
  };
}
