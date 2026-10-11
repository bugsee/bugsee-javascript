# Report dialog (`showReportDialog`) — browser

Status: **Design approved, in build.** 2026-10-11.

A built-in, dynamically created bug-report form for browser installs, the web counterpart of the
mobile SDKs' `showReportDialog()` (Android `BugReportingActivity`, iOS `BGSReportController`).

## What the mobile SDKs do (research, 2026-10-11)

Both show a **full-screen form with no dim overlay**: Android an `Activity`, iOS a table in its own
overlay window. The shared field order, with placeholders as the only labels:

1. Summary — single line, "Short summary"
2. Description — multi-line, "Bug description" (the screenshot thumbnail sits inside it)
3. Severity picker — five bug icons: Low / Medium / High / Critical / Blocker (hidden unless enabled)
4. Labels — comma separated, "Labels" (hidden unless enabled)
5. Email — "Reporter email", pre-filled from the stored user identifier, persisted on send
6. `v<sdk version>` footer

Top bar: close X, title, **Send**; footer: SDK version and the Bugsee mark with "Powered by Bugsee"
(a link to bugsee.com, `rel="noopener noreferrer"`). Required fields are summary, description, email, labels, each
opt-in through `com.bugsee.option.reporting.ui.*`; an invalid form cannot be sent, with inline error
text on Android. Cancelling asks for confirmation ("The recorded session up to this point will be
discarded"). Source type on the wire is `code_dialog`; a silent upload is `code_upload`.

## Decisions

| # | Decision |
|---|---|
| D1 | **Page-shaded modal, not full screen.** The brief is a dialog on top of everything with the page dimmed. Same fields, order, strings, colours and validation as mobile; the card is centred over a shading layer. |
| D2 | **Top layer.** A native `<dialog>` opened with `showModal()`: it sits above every z-index, and above any other modal the page has open, and makes the page inert (focus trap, Esc). Fallback when `showModal` is missing: a fixed overlay at the maximum z-index. |
| D3 | **Isolated.** The UI lives in a shadow root on a single host element, so page CSS cannot restyle it and ours cannot leak. Built with DOM APIs only — user text is never parsed as HTML. |
| D4 | **No screenshot in v1.** The report already carries the DOM snapshot (and replay when enabled). A pixel screenshot needs a rasterizer or a permission prompt; it can be added later as an opt-in without changing the API. |
| D5 | **Lives in `@bugsee/browser`**, always bundled (decision of 2026-10-11). Node/edge/worker builds never import it. |
| D6 | **Core gets a runtime-neutral `upload()`** — the manual-report entry point Android has — so the dialog is only UI. `trigger` selects `code_upload` (default) or `code_dialog`. |
| D7 | **The report is prepared when the dialog opens**, as on Android (`createAndPrepareBugReport` runs before the form is shown). `client.prepareUpload()` freezes the capture (drain + report-time snapshots) and returns `{ send, discard }`; Send submits that frozen capture, cancel/discard releases it. Without this the report is taken at Send, and with the default 60 s window a user who spends a minute writing pushes the incident out of the buffer and fills the report with the typing itself. |
| D8 | **Embedders can restyle it, on purpose.** Every element has a `bugsee-reporting-dialog-*` class and the same name as a `part`; every colour is a `--bugsee-reporting-dialog-*` custom property; `showReportDialog({ css })` appends a stylesheet inside the shadow root. Page rules reach in through `::part()` and custom properties set on `.bugsee-reporting-dialog` (the host); the shadow root keeps accidental page CSS out. |
| D9 | **Styles are adopted, not injected.** Constructable stylesheets (`adoptedStyleSheets`) are used when available, because a strict `style-src` CSP blocks a `<style>` element (shadow roots included) and the dialog would render unstyled; a `<style>` element is the fallback. |

## API

```ts
client.showReportDialog(options?: ReportDialogOptions): Promise<UploadResult | null>
```

- Resolves `null` when the user cancels, or when a dialog is already open / the SDK is not launched.
- Otherwise resolves the `UploadResult` of the submitted report.
- `ReportDialogOptions`: `summary`, `description`, `severity`, `labels` (pre-fill, as on mobile),
  `strings` (localisation / placeholder overrides), `theme` (`'auto' | 'light' | 'dark'`).

```ts
client.upload(options?: UploadOptions): Promise<UploadResult>   // core; no UI
```

## Launch options (browser)

Canonical `com.bugsee.option.reporting.*` keys, defaults equal to mobile (all off, default priority High):

| Friendly | Canonical |
|---|---|
| `reportSummaryRequired` | `…reporting.ui.summary-required` |
| `reportDescriptionRequired` | `…reporting.ui.description-required` |
| `reportEmailRequired` | `…reporting.ui.email-required` |
| `reportLabelsEnabled` | `…reporting.ui.labels-enabled` |
| `reportLabelsRequired` | `…reporting.ui.labels-required` |
| `reportPrioritySelectorEnabled` | `…reporting.ui.priority-selector-enabled` |
| `reportDefaultBugPriority` | `…reporting.defaults.bug-priority` |

## Deliberate deviations from mobile

- **Send stays enabled** while the form is invalid; clicking it shows the inline errors and focuses the
  first invalid field (a disabled button gives a keyboard/screen-reader user no reason).
- **Enter in a single-line field moves to the next field** (and sends from the last one), so a user who
  presses Enter after the summary does not send a half-written report. An IME's Enter is left alone.
- **No email format check.** The "email" is the app's user identifier, which is often not an address;
  neither mobile SDK validates it. Erasing it clears the identifier (iOS `clearEmail`), a changed value is
  remembered for the session. (The mobile SDKs also persist it across launches; the JS identifier is held
  in memory only today, so it is not persisted across page loads.)
- **A browser-initiated close is a cancel.** Chrome makes a second Escape non-cancellable; the dialog's
  `close` listener tears everything down (host, scroll lock, launcher state) instead of leaving the page
  locked.
- **Cancel confirms only a dirty form.** An untouched form closes at once.
- **Fields carry real `<label>`s** (visually hidden), in addition to the placeholders, for assistive tech.
- **Severity is a radio group**, not five tappable images.

## Out of scope

Screenshot thumbnail and annotation editor; multi-display; `bugseeAddFieldsBeforeReportCreated`-style
pre-fill delegates (the existing `setReportHandler({before})` already covers mutate/veto).
