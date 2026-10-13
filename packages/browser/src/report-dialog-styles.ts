// The report dialog's built-in stylesheet, injected into its shadow root only — page CSS cannot reach in
// by accident and none of this leaks out.
//
// EVERY class is prefixed `bugsee-reporting-dialog-` and is also exported as a `part` of the same name,
// and every colour is a `--bugsee-reporting-dialog-*` custom property, so an embedder can restyle the
// dialog on purpose:
//
//   /* page stylesheet — custom properties inherit into the shadow root */
//   .bugsee-reporting-dialog { --bugsee-reporting-dialog-accent: #0a5; }
//   /* page stylesheet — any element by its part name */
//   .bugsee-reporting-dialog::part(bugsee-reporting-dialog-card) { border-radius: 16px; }
//   /* or inside the shadow root: showReportDialog({ css: '.bugsee-reporting-dialog-send { … }' }) */
//
// Colours are the mobile SDKs' (Android `ColorConstants`, iOS `BugseeTheme`): the light page is #EDF1F6
// with white fields, the dark page #121212, the accent was red #FF5858 (now the viewer's brand teal), the severity icons green/amber/
// salmon/red/dark-red. The accent is the viewer's brand teal (#60B4C4; #3A8A99 on the light page, the
// viewer's AA-contrast variant). Two deliberate adjustments for the web, both for contrast: the light text is a
// shade darker than Android's #637E99 (4.2:1 on white) and the dark field is #262626 rather than #777777.

/** The prefix of every class, part and custom property the dialog exposes. */
export const REPORT_DIALOG_CLASS_PREFIX = 'bugsee-reporting-dialog-';

/** The highest z-index a page can use — only matters on the no-`showModal` fallback path. */
export const MAX_Z_INDEX = 2147483647;

const p = REPORT_DIALOG_CLASS_PREFIX;
// A custom property reference with its built-in default, so the host/page can override any one of them.
const v = (name: string): string => `var(--${p}${name})`;

export const REPORT_DIALOG_CSS = `
:host {
  all: initial;
  color-scheme: light;
  --${p}page: #EDF1F6;
  --${p}field: #FFFFFF;
  --${p}field-border: rgba(153, 153, 153, 0.4);
  --${p}text: #4F6A85;
  --${p}hint: #8497AB;
  --${p}accent: #3A8A99;
  --${p}error: #C62828;
  --${p}severity-active: #182433;
  --${p}severity-idle: #637E99;
  --${p}shade: rgba(0, 0, 0, 0.55);
  --${p}shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  --${p}radius: 12px;
  font: 17px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
:host([data-theme='dark']) {
  color-scheme: dark;
  --${p}page: #121212;
  --${p}field: #262626;
  --${p}field-border: #555555;
  --${p}text: #FFFFFF;
  --${p}hint: #B4B4B4;
  --${p}accent: #60B4C4;
  --${p}error: #FF8A80;
  --${p}severity-active: #FFFFFF;
  --${p}severity-idle: #B4B4B4;
}
@media (prefers-color-scheme: dark) {
  :host([data-theme='auto']) {
    color-scheme: dark;
    --${p}page: #121212;
    --${p}field: #262626;
    --${p}field-border: #555555;
    --${p}text: #FFFFFF;
    --${p}hint: #B4B4B4;
    --${p}accent: #60B4C4;
    --${p}error: #FF8A80;
    --${p}severity-active: #FFFFFF;
    --${p}severity-idle: #B4B4B4;
  }
}

*, *::before, *::after { box-sizing: border-box; }

/* The page shading. The dialog element IS the shading layer: viewport-sized, with the card centred inside
   it. In the top layer (showModal) it sits above every z-index and above any other modal the page has
   open; the fallback pins it with position: fixed at the maximum z-index. */
.${p}overlay {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 16px;
  border: 0;
  background: ${v('shade')};
  display: none;
  align-items: center;
  justify-content: center;
  overflow: auto;
  color: ${v('text')};
}
.${p}overlay[open] { display: flex; }
.${p}overlay[data-fallback='true'] { z-index: ${MAX_Z_INDEX}; }
.${p}overlay::backdrop { background: transparent; }

.${p}card {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: 100%;
  margin: auto;
  background: ${v('page')};
  border: 1px solid ${v('field-border')};
  border-radius: ${v('radius')};
  box-shadow: ${v('shadow')};
  overflow: hidden;
}

.${p}bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 56px;
  padding: 0 8px 0 8px;
  flex: none;
}
.${p}title {
  flex: 1;
  margin: 0;
  text-align: center;
  font-size: 17px;
  font-weight: 700;
  text-transform: uppercase;
  color: ${v('text')};
}
.${p}close {
  width: 44px;
  height: 44px;
  padding: 10px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: ${v('text')};
  cursor: pointer;
}
.${p}close-icon { display: block; width: 100%; height: 100%; fill: currentColor; }
.${p}send {
  width: 44px;
  height: 44px;
  padding: 9px; /* the arrowhead is a solid shape, so it reads smaller than the thin close glyph at the same size */
  border: 0;
  border-radius: 50%;
  background: none;
  color: ${v('accent')};
  cursor: pointer;
}
.${p}send-icon {
  display: block;
  width: 100%;
  height: 100%;
  fill: currentColor;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;
}
.${p}send:disabled { opacity: 0.5; cursor: default; }
.${p}close:hover, .${p}send:hover:not(:disabled) { background: rgba(128, 128, 128, 0.15); }

.${p}body {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 12px 12px 16px;
  overflow: auto;
}
.${p}row { display: flex; flex-direction: column; gap: 4px; }
/* The visible label is the placeholder (as on mobile); the real <label> is there for assistive tech.
   Embedders who want visible labels override this one class. */
.${p}label {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.${p}input {
  width: 100%;
  padding: 12px;
  font: inherit;
  color: ${v('text')};
  background: ${v('field')};
  border: 1px solid ${v('field-border')};
  border-radius: 8px;
}
.${p}input::placeholder { color: ${v('hint')}; opacity: 1; }
textarea.${p}input { min-height: 8.2em; resize: vertical; }
.${p}input:focus-visible { outline: 2px solid ${v('accent')}; outline-offset: 1px; }
.${p}input[aria-invalid='true'] { border-color: ${v('error')}; }
.${p}error { min-height: 0; margin: 0; font-size: 13px; color: ${v('error')}; }
.${p}error:empty { display: none; }

.${p}severity { display: flex; margin: 8px 0 0; padding: 0; border: 0; min-width: 0; }
.${p}severity-option {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 4px 0;
  font-size: 13px;
  color: ${v('severity-idle')};
  cursor: pointer;
}
/* The radio is visually hidden; the icon is its face. */
.${p}severity-radio {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
.${p}severity-icon { width: 32px; height: 32px; fill: currentColor; opacity: 0.2; }
.${p}severity-radio:checked + .${p}severity-icon { opacity: 1; }
.${p}severity-option:has(.${p}severity-radio:checked) { color: ${v('severity-active')}; }
.${p}severity-radio:focus-visible + .${p}severity-icon { outline: 2px solid ${v('accent')}; border-radius: 4px; }
.${p}severity-low .${p}severity-icon { color: #00C853; }
.${p}severity-medium .${p}severity-icon { color: #DFC12A; }
.${p}severity-high .${p}severity-icon { color: #F27979; }
.${p}severity-critical .${p}severity-icon { color: #E03D3D; }
.${p}severity-blocker .${p}severity-icon { color: #8C0101; }

.${p}footer-row {
  display: grid;
  grid-template-columns: auto auto;
  justify-content: center;
  align-items: center;
  column-gap: 10px;
  padding: 0 12px 14px;
  flex: none;
}
/* The link has no box of its own: its logo and text are laid out on the footer grid, with the version
   line under the text. */
.${p}powered { display: contents; font-size: 16px; color: ${v('hint')}; text-decoration: none; }
.${p}logo { grid-column: 1; grid-row: 1 / span 2; display: block; height: 30px; width: auto; }
.${p}powered-text { grid-column: 2; grid-row: 1; font-size: 16px; color: ${v('hint')}; }
.${p}version { grid-column: 2; grid-row: 2; margin: 0; font-size: 10px; color: ${v('hint')}; opacity: 0.4; }
.${p}powered:hover .${p}powered-text { color: ${v('text')}; text-decoration: underline; }
.${p}powered:focus-visible .${p}powered-text,
.${p}powered:focus-visible .${p}logo { outline: 2px solid ${v('accent')}; outline-offset: 2px; border-radius: 2px; }

.${p}confirm {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  background: ${v('page')};
}
.${p}confirm[hidden] { display: none; }
.${p}confirm-title { margin: 0; font-size: 20px; color: ${v('text')}; }
.${p}confirm-body { margin: 0; font-size: 16px; }
.${p}confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
.${p}confirm-button {
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 3px;
  background: none;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  cursor: pointer;
  color: ${v('hint')};
}
.${p}confirm-discard { color: ${v('accent')}; }

/* On a phone-sized viewport the card is the mobile SDKs' full-screen form. */
@media (max-width: 480px) {
  .${p}overlay { padding: 0; }
  .${p}card { width: 100%; height: 100%; border-radius: 0; }
}
@media (prefers-reduced-motion: no-preference) {
  .${p}overlay[open] .${p}card { animation: ${p}card-in 120ms ease-out; }
  @keyframes ${p}card-in { from { opacity: 0; transform: translateY(8px); } }
}
`;
