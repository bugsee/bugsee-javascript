// The report dialog's user-facing text. English defaults are the mobile SDKs' own strings (Android
// `res/values/strings.xml`, iOS `BGSLocalizedString` keys) so a bug reported from the web reads the same
// as one reported from a phone; the few extra strings are web-only (title, discard, sending).
// Every string is overridable per call through `showReportDialog({ strings })` — that is the
// localisation seam, there is no built-in translation table to ship to every customer.

export interface ReportDialogStrings {
  /** Dialog heading. */
  title: string;
  /** Accessible name of the close (X) button. */
  close: string;
  summaryPlaceholder: string;
  descriptionPlaceholder: string;
  labelsPlaceholder: string;
  emailPlaceholder: string;
  /** Accessible name of the severity radio group. */
  severityLegend: string;
  severityLow: string;
  severityMedium: string;
  severityHigh: string;
  severityCritical: string;
  severityBlocker: string;
  send: string;
  sending: string;
  summaryRequired: string;
  descriptionRequired: string;
  emailRequired: string;
  labelsRequired: string;
  emailInvalid: string;
  discardTitle: string;
  discardBody: string;
  discardKeep: string;
  discardConfirm: string;
  /** The attribution link next to the Bugsee logo, at the bottom of the dialog. */
  poweredBy: string;
}

export const DEFAULT_REPORT_DIALOG_STRINGS: ReportDialogStrings = {
  title: 'Report a bug',
  close: 'Close',
  summaryPlaceholder: 'Short summary',
  descriptionPlaceholder: 'Bug description',
  labelsPlaceholder: 'Labels',
  emailPlaceholder: 'Reporter email',
  severityLegend: 'Severity',
  severityLow: 'Low',
  severityMedium: 'Medium',
  severityHigh: 'High',
  severityCritical: 'Critical',
  severityBlocker: 'Blocker',
  send: 'Send',
  sending: 'Sending…',
  summaryRequired: 'Summary is required',
  descriptionRequired: 'Description is required',
  emailRequired: 'Email is required',
  labelsRequired: 'Labels must be specified',
  emailInvalid: 'Enter a valid email address',
  discardTitle: 'Cancel report',
  discardBody: 'The recorded session up to this point will be discarded. Are you sure?',
  discardKeep: 'Keep editing',
  discardConfirm: 'Discard',
  poweredBy: 'Powered by Bugsee',
};
