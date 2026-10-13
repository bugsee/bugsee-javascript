import {
  type InternalPreparedUpload,
  LifecycleEvents,
  type LifecycleEventType,
  type UploadResult,
} from '@bugsee/core';
import { DEFAULT_REPORT_DIALOG_STRINGS, type ReportDialogStrings } from './report-dialog-strings';
import { REPORT_DIALOG_CLASS_PREFIX, REPORT_DIALOG_CSS } from './report-dialog-styles';

// The browser's `showReportDialog()` — the web counterpart of the mobile SDKs' report form (Android
// `BugReportingActivity`, iOS `BGSReportController`). Same fields, order, strings and validation; shown
// as a modal over a shaded page rather than full screen.
//
// Hard rules this file keeps:
//   - the UI lives in ONE shadow root on ONE host element, so page CSS cannot accidentally restyle it.
//     Embedders restyle it ON PURPOSE through three doors: every element carries a `bugsee-reporting-
//     dialog-*` class AND the same name as a `part` (so `host::part(bugsee-reporting-dialog-card)` works
//     from the page's own stylesheet), every colour is a `--bugsee-reporting-dialog-*` custom property,
//     and `showReportDialog({ css })` appends a stylesheet inside the shadow root;
//   - it is built with DOM APIs only, so user text is never parsed as HTML;
//   - it sits in the TOP LAYER (`<dialog>.showModal()`), above every z-index and above any modal the page
//     already has open; the fixed/max-z-index fallback exists only for browsers without `showModal`;
//   - the report is PREPARED when the dialog opens (the capture is frozen then), so what the user does
//     while typing never pushes the incident out of the rolling buffer;
//   - it never throws into the host page: a dialog that cannot be built resolves `null` and leaves no
//     trace (no host element, no scroll lock).

/** A severity by name; `low` and `verylow` are the same wire value. */
export type SeverityName = 'verylow' | 'low' | 'medium' | 'high' | 'critical' | 'blocker';

export type { ReportDialogStrings } from './report-dialog-strings';
export { DEFAULT_REPORT_DIALOG_STRINGS } from './report-dialog-strings';

/** The dialog severities, in display order (the five mobile picker entries). */
const SEVERITIES = ['low', 'medium', 'high', 'critical', 'blocker'] as const;
type PickerSeverity = (typeof SEVERITIES)[number];

const ALL_SEVERITIES: readonly string[] = ['verylow', ...SEVERITIES];

/**
 * A severity name from untrusted input (a launch option, a per-call option): the canonical name, or
 * `undefined` for anything else. Case and surrounding space are forgiven; a number or `'urgent'` is not.
 */
export function parseSeverityName(value: unknown): SeverityName | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim().toLowerCase();
  return ALL_SEVERITIES.includes(name) ? (name as SeverityName) : undefined;
}

/** Per-call options of `client.showReportDialog(options)`. */
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
  /**
   * Extra CSS, appended inside the dialog's shadow root after the built-in styles. Write ordinary rules
   * against the `bugsee-reporting-dialog-*` classes, e.g. `.bugsee-reporting-dialog-send { color: navy }`.
   * (Rules in the PAGE's stylesheet reach the dialog through `::part(...)` and custom properties only.)
   */
  css?: string;
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
  /** Freeze the capture and return the report-in-waiting (`client.prepareUpload`); `null` = cannot. */
  prepare(): InternalPreparedUpload | null;
  /** The dialog does nothing, as on mobile, while the SDK is not running. */
  isLaunched(): boolean;
  getUserIdentifier(): string | null;
  setUserIdentifier(email: string): void;
  clearUserIdentifier(): void;
  /** Shown in the footer as `v<sdkVersion>`. */
  sdkVersion: string;
  ui: ReportDialogUiOptions;
  /**
   * Lifecycle hook (`client.emitLifecycleEvent`): told BeforeReportShown just before the dialog is put on
   * the page and AfterReportShown once it is gone, however it closed. Never expected to throw.
   */
  emitLifecycleEvent?: (eventType: LifecycleEventType, data?: unknown) => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// Material "bug_report" and "close" glyphs (Apache-2.0).
const BUG_PATH =
  'M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a6.002 6.002 0 0 0-2.83 0L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z';
// A send arrowhead with a slit in its back edge. It is filled AND stroked (see `.send-icon` in the styles) so
// the corners come out rounded.
const SEND_PATH = 'M4.3 3.9 21.4 12.4 4.3 20.9 5.8 14 15 12.6 5.8 10.8Z';
const CLOSE_PATH =
  'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

// The Bugsee mark (brand red body, white eye) — the same artwork as the viewer's logo.svg.
const LOGO_BODY =
  'm102 251.9h30.4v-31h10v31.1h30.4v-31h40v31.1h30.4v-31h10v31.1h33.7c-2.8-9.2-4.3-19-4.3-29.1 0-55.4 45.2-100.4 100.9-100.4 40.6 0 75.6 23.9 91.6 58.3h19.1c-17.6-59.2-56.5-109.3-108-141.4 1.7-7.8.2-15.9-3.9-22.6-7.7.3-15.1 3.5-20.6 9.1-33.1-15.9-70.2-24.8-109.5-24.8-139.3 0-252.3 112.3-252.3 250.9h82v-31h20v31.1zm240-149.5c13.9 0 25.2-11.2 25.2-25.1s-11.3-25.1-25.2-25.1-25.2 11.2-25.2 25.1 11.3 25.1 25.2 25.1zm9.1-7c5.6 0 10.1-4.5 10.1-10s-4.5-10-10.1-10-10.1 4.5-10.1 10 4.5 10 10.1 10zm-20.7-43.3';
const LOGO_HORN =
  'm330.4 52.1c9.6-4.1 16.9-13 18.2-24.1s-3.5-21.5-11.9-27.8c-9.6 4.1-16.9 13-18.2 24.1s3.5 21.5 11.9 27.8z';
const BUGSEE_URL = 'https://bugsee.com';

const P = REPORT_DIALOG_CLASS_PREFIX;

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
  discard: HTMLButtonElement;
  fields: Partial<Record<FieldName, HTMLInputElement | HTMLTextAreaElement>>;
  errors: Partial<Record<FieldName, HTMLElement>>;
  radios: HTMLInputElement[];
}

const definedStrings = (
  strings: Partial<ReportDialogStrings> | undefined,
): Partial<ReportDialogStrings> =>
  Object.fromEntries(
    Object.entries(strings ?? {}).filter(([, value]) => typeof value === 'string'),
  );

function showDialog(
  deps: ReportDialogDeps,
  options: ReportDialogOptions,
  finish: (result: UploadResult | null) => void,
): void {
  const { document: doc, ui } = deps;
  // Freeze the capture FIRST, before any UI exists: the report is the moment the dialog was asked for.
  const prepared = deps.prepare();
  if (prepared === null) {
    finish(null);
    return;
  }
  const strings: ReportDialogStrings = {
    ...DEFAULT_REPORT_DIALOG_STRINGS,
    ...definedStrings(options.strings),
  };
  const initialEmail = deps.getUserIdentifier() ?? '';
  const defaultSeverity = parseSeverityName(options.severity) ?? ui.defaultSeverity;
  const initialSeverity = pickerSeverity(defaultSeverity);
  let refs: Refs;
  try {
    refs = build(doc, strings, ui, options, initialEmail, initialSeverity, deps.sdkVersion);
  } catch (error) {
    prepared.discard();
    throw error;
  }

  const previousFocus = doc.activeElement as HTMLElement | null;
  const previousOverflow = doc.documentElement.style.overflow;
  let busy = false;
  let closed = false;
  let announced = false;

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

  /** Tear everything down and settle. Idempotent; leaves no host element and no scroll lock behind. */
  const closeDialog = (result: UploadResult | null): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (result === null) {
      prepared.discard();
    }
    refs.host.remove();
    doc.documentElement.style.overflow = previousOverflow;
    try {
      previousFocus?.focus?.();
    } catch {
      // a focus target that went away is not worth failing the close for
    }
    // Announced once the dialog is really gone, so a listener that inspects the page sees it closed; and
    // `sent` is true only when the report was accepted (a refused or failed send is not "sent").
    if (announced) {
      try {
        deps.emitLifecycleEvent?.(LifecycleEvents.AfterReportShown, { sent: result?.ok === true });
      } catch {
        // the hook is the platform's and never expected to throw; if it does, the dialog still settles
      }
    }
    finish(result);
  };

  const setBusy = (value: boolean): void => {
    busy = value;
    refs.send.disabled = value;
    refs.send.setAttribute('aria-label', value ? strings.sending : strings.send);
    refs.send.title = value ? strings.sending : strings.send;
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
    // No format check, as on Android and iOS: the "email" is the app's user identifier, which is often
    // not an address, and refusing to send a report over it helps nobody.
    if (ui.emailRequired && fieldValue('email') === '') {
      problems.push(['email', strings.emailRequired]);
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
    const severity: SeverityName = ui.prioritySelectorEnabled ? severityValue() : defaultSeverity;

    // The reporter email IS the global user identifier (mobile parity). A changed value is remembered;
    // an ERASED one is cleared (iOS `clearEmail`), otherwise the report would quietly carry it anyway
    // through the identifier fallback.
    if (email !== '' && email !== initialEmail) {
      deps.setUserIdentifier(email);
    } else if (email === '' && initialEmail !== '') {
      deps.clearUserIdentifier();
    }
    setBusy(true);
    let sent: Promise<UploadResult>;
    try {
      sent = prepared.send({
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
  refs.discard.addEventListener('click', () => closeDialog(null));
  // Escape. The browser would close a modal dialog on its own, discarding the form silently, so a
  // cancellable `cancel` is turned into the usual cancel flow. Chrome makes `cancel` NON-cancellable when
  // there was no user activation since the last one (a second Escape): the dialog is then going to close
  // whatever we do, and the `close` listener below does the cleanup.
  refs.dialog.addEventListener('cancel', (event) => {
    if (!event.cancelable) {
      return;
    }
    event.preventDefault();
    requestCancel();
  });
  // The browser closed the dialog under us (the non-cancellable Escape above, or a page script calling
  // `close()`): without this the host element, the scroll lock and the launcher's "already open" flag
  // would all stay behind, and `showReportDialog()` would stay dead until a reload.
  refs.dialog.addEventListener('close', () => closeDialog(null));
  // A click on the shading (the dialog element itself, not the card) is a cancel; clicks inside the card
  // have the card's descendants as their target.
  refs.dialog.addEventListener('click', (event) => {
    if (event.target === refs.dialog) {
      requestCancel();
    }
  });
  const controls = Object.values(refs.fields);
  for (const name of Object.keys(refs.fields) as FieldName[]) {
    refs.fields[name]?.addEventListener('input', () => setError(name, ''));
  }
  // Enter in a single-line field moves to the next field (the summary is followed by the description),
  // instead of sending a half-written report through implicit form submission. Enter in the LAST field
  // sends. An Enter that confirms an IME composition (CJK input) is the IME's, not ours.
  for (const [index, control] of controls.entries()) {
    if (control instanceof HTMLTextAreaElement) {
      continue;
    }
    control.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) {
        return;
      }
      event.preventDefault();
      const next = controls[index + 1];
      if (next === undefined) {
        submit();
      } else {
        next.focus();
      }
    });
  }

  try {
    announced = true;
    deps.emitLifecycleEvent?.(LifecycleEvents.BeforeReportShown);
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
  } catch {
    closeDialog(null);
  }
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
  /** A styling hook: the class AND the same-named `part`, so page CSS can use `::part()` too. */
  const hook = (element: Element, ...names: string[]): void => {
    const tokens = names.map((name) => `${P}${name}`).join(' ');
    element.setAttribute('class', tokens);
    element.setAttribute('part', tokens);
  };
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
  const icon = (path: string, ...names: string[]): SVGElement => {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    hook(svg, ...names);
    const shape = doc.createElementNS(SVG_NS, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    return svg;
  };

  const host = make('div', {
    'data-bugsee-report-dialog': '',
    'data-theme': options.theme ?? 'auto',
  });
  // The host carries the root class (and is the element a page rule targets for custom properties).
  host.setAttribute('class', P.slice(0, -1));
  const shadow = host.attachShadow({ mode: 'open' });
  attachStyles(doc, shadow, options.css);

  const titleId = 'bugsee-reporting-dialog-title';
  const dialog = make('dialog', { 'aria-labelledby': titleId });
  hook(dialog, 'overlay');
  const form = make('form', { novalidate: '' });
  hook(form, 'card');

  const close = make('button', { type: 'button', 'aria-label': strings.close });
  hook(close, 'close');
  close.setAttribute('data-action', 'cancel');
  close.append(icon(CLOSE_PATH, 'close-icon'));
  const send = make('button', {
    type: 'submit',
    'aria-label': strings.send,
    title: strings.send,
  });
  hook(send, 'send');
  send.setAttribute('data-action', 'send');
  const sendIcon = icon(SEND_PATH, 'send-icon');
  send.append(sendIcon);
  const bar = make('div');
  hook(bar, 'bar');
  const title = make('h2', { id: titleId }, strings.title);
  hook(title, 'title');
  bar.append(close, title, send);

  const body = make('div');
  hook(body, 'body');
  const fields: Refs['fields'] = {};
  const errors: Refs['errors'] = {};

  const addField = (
    name: FieldName,
    control: HTMLInputElement | HTMLTextAreaElement,
    placeholder: string,
    value: string,
  ): void => {
    const id = `bugsee-reporting-dialog-${name}`;
    control.id = id;
    control.setAttribute('data-field', name);
    hook(control, 'input', `input-${name}`);
    control.setAttribute('placeholder', placeholder);
    control.setAttribute('aria-describedby', `${id}-error`);
    control.value = value;
    // A real <label> for assistive tech; visually hidden by default (the placeholder is the visible
    // label, as on mobile) and restyleable through `.bugsee-reporting-dialog-label`.
    const label = make('label', { for: id }, placeholder);
    hook(label, 'label');
    const error = make('p', { id: `${id}-error`, 'aria-live': 'polite' });
    hook(error, 'error');
    error.setAttribute('data-error-for', name);
    const row = make('div');
    hook(row, 'row', `row-${name}`);
    row.append(label, control, error);
    body.append(row);
    fields[name] = control;
    errors[name] = error;
  };

  addField(
    'summary',
    make('input', { type: 'text', autocomplete: 'off', enterkeyhint: 'next' }),
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
    const group = make('div', { role: 'radiogroup', 'aria-label': strings.severityLegend });
    hook(group, 'severity');
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
        name: 'bugsee-reporting-dialog-severity',
        value: severity,
      });
      hook(radio, 'severity-radio');
      radio.checked = severity === initialSeverity;
      radios.push(radio);
      const label = make('label');
      hook(label, 'severity-option', `severity-${severity}`);
      label.append(radio, icon(BUG_PATH, 'severity-icon'), doc.createTextNode(names[severity]));
      group.append(label);
    }
    body.append(group);
  }

  if (ui.labelsEnabled) {
    addField(
      'labels',
      make('input', { type: 'text', autocomplete: 'off', enterkeyhint: 'next' }),
      strings.labelsPlaceholder,
      (options.labels ?? []).join(', '),
    );
  }
  addField(
    'email',
    make('input', {
      type: 'email',
      autocomplete: 'email',
      inputmode: 'email',
      enterkeyhint: 'send',
    }),
    strings.emailPlaceholder,
    initialEmail,
  );

  const version = make('p', {}, `v${sdkVersion}`);
  hook(version, 'version');
  version.setAttribute('data-footer', '');

  // "Powered by Bugsee": opens bugsee.com in a NEW tab that gets no `window.opener` (noopener) and no
  // Referer (noreferrer — the host page's URL can carry tokens or ids and must not leak to us).
  const logo = doc.createElementNS(SVG_NS, 'svg');
  logo.setAttribute('viewBox', '0 0 495 252');
  logo.setAttribute('aria-hidden', 'true');
  hook(logo, 'logo');
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
  const powered = make('a', { href: BUGSEE_URL, target: '_blank', rel: 'noopener noreferrer' });
  hook(powered, 'powered');
  powered.setAttribute('data-powered', '');
  const poweredText = make('span', {}, strings.poweredBy);
  hook(poweredText, 'powered-text');
  powered.append(logo, poweredText);
  const footerRow = make('div');
  hook(footerRow, 'footer-row');
  footerRow.append(version, powered);

  const confirm = make('div', {
    role: 'alertdialog',
    'aria-labelledby': 'bugsee-reporting-dialog-discard-title',
    hidden: '',
  });
  hook(confirm, 'confirm');
  confirm.setAttribute('data-confirm', '');
  const keep = make('button', { type: 'button' }, strings.discardKeep);
  hook(keep, 'confirm-button', 'confirm-keep');
  keep.setAttribute('data-action', 'keep');
  const discard = make('button', { type: 'button' }, strings.discardConfirm);
  hook(discard, 'confirm-button', 'confirm-discard');
  discard.setAttribute('data-action', 'discard');
  const actions = make('div');
  hook(actions, 'confirm-actions');
  actions.append(keep, discard);
  const discardTitle = make(
    'h3',
    { id: 'bugsee-reporting-dialog-discard-title' },
    strings.discardTitle,
  );
  hook(discardTitle, 'confirm-title');
  const discardBody = make('p', {}, strings.discardBody);
  hook(discardBody, 'confirm-body');
  confirm.append(discardTitle, discardBody, actions);

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
    discard,
    fields: fields as Refs['fields'],
    errors,
    radios,
  };
}

/**
 * Put the stylesheets in the shadow root. Constructable stylesheets are preferred: a strict
 * `style-src` Content-Security-Policy (no `'unsafe-inline'`, no nonce) blocks a `<style>` element —
 * shadow roots included — and the dialog would render unstyled, but it does not block
 * `adoptedStyleSheets`. Where they are unavailable, or throw, a `<style>` element is the fallback.
 */
function attachStyles(doc: Document, shadow: ShadowRoot, userCss: string | undefined): void {
  const sheets = [
    REPORT_DIALOG_CSS,
    ...(typeof userCss === 'string' && userCss !== '' ? [userCss] : []),
  ];
  const Sheet = (doc.defaultView as { CSSStyleSheet?: typeof CSSStyleSheet } | null)?.CSSStyleSheet;
  if (Sheet !== undefined && 'adoptedStyleSheets' in shadow && 'replaceSync' in Sheet.prototype) {
    try {
      const adopted = sheets.map((css) => {
        const sheet = new Sheet();
        sheet.replaceSync(css);
        return sheet;
      });
      (shadow as ShadowRoot & { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets = adopted;
      return;
    } catch {
      // fall through to <style> elements
    }
  }
  for (const css of sheets) {
    const style = doc.createElement('style');
    style.textContent = css;
    shadow.append(style);
  }
}
