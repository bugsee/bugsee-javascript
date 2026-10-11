// The report dialog's stylesheet, injected into its shadow root only — page CSS cannot reach in and
// none of this leaks out.
//
// Colours are the mobile SDKs' (Android `ColorConstants`, iOS `BugseeTheme`): the light page is
// #EDF1F6 with white fields, the dark page #121212, the accent red #FF5858, the severity icons
// green/amber/salmon/red/dark-red. Two deliberate adjustments for the web, both for contrast: the light
// text is a shade darker than Android's #637E99 (4.2:1 on white) and the dark field is #262626 rather
// than #777777 (white text on #777 is 4.5:1 at best).

/** The highest z-index a page can use — only matters on the no-`showModal` fallback path. */
export const MAX_Z_INDEX = 2147483647;

export const REPORT_DIALOG_CSS = `
:host {
  all: initial;
  color-scheme: light;
  --page: #EDF1F6;
  --field: #FFFFFF;
  --field-border: rgba(153, 153, 153, 0.4);
  --text: #4F6A85;
  --hint: #8497AB;
  --accent: #FF5858;
  --error: #C62828;
  --sev-active: #182433;
  --sev-idle: #637E99;
  --shade: rgba(0, 0, 0, 0.55);
  --shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  font: 17px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
:host([data-theme='dark']) {
  color-scheme: dark;
  --page: #121212;
  --field: #262626;
  --field-border: #555555;
  --text: #FFFFFF;
  --hint: #B4B4B4;
  --error: #FF8A80;
  --sev-active: #FFFFFF;
  --sev-idle: #B4B4B4;
}
@media (prefers-color-scheme: dark) {
  :host([data-theme='auto']) {
    color-scheme: dark;
    --page: #121212;
    --field: #262626;
    --field-border: #555555;
    --text: #FFFFFF;
    --hint: #B4B4B4;
    --error: #FF8A80;
    --sev-active: #FFFFFF;
    --sev-idle: #B4B4B4;
  }
}

*, *::before, *::after { box-sizing: border-box; }

/* The page shading. The dialog element IS the shading layer: transparent-bordered, viewport-sized,
   with the card centred inside it. In the top layer (showModal) it sits above every z-index and above
   any other modal the page has open; the fallback pins it with position: fixed at the maximum z-index. */
.overlay {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 16px;
  border: 0;
  background: rgba(0, 0, 0, 0.55);
  display: none;
  align-items: center;
  justify-content: center;
  overflow: auto;
  color: var(--text);
}
.overlay[open] { display: flex; }
.overlay[data-fallback='true'] { z-index: ${MAX_Z_INDEX}; }
.overlay::backdrop { background: transparent; }

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: 100%;
  margin: auto;
  background: var(--page);
  border-radius: 8px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 56px;
  padding: 0 8px 0 4px;
  flex: none;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}
.title {
  flex: 1;
  margin: 0;
  text-align: center;
  font-size: 17px;
  font-weight: 600;
  color: var(--accent);
}
.close {
  width: 44px;
  height: 44px;
  padding: 10px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--accent);
  cursor: pointer;
}
.close svg { display: block; width: 100%; height: 100%; fill: currentColor; }
.send {
  min-width: 64px;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 3px;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
}
.send:disabled { opacity: 0.5; cursor: default; }
.close:hover, .send:hover:not(:disabled) { background: rgba(255, 88, 88, 0.1); }

.body {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 12px 12px 16px;
  overflow: auto;
}
.row { display: flex; flex-direction: column; gap: 4px; }
.sr-only {
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
.input {
  width: 100%;
  padding: 12px;
  font: inherit;
  color: var(--text);
  background: var(--field);
  border: 1px solid var(--field-border);
  border-radius: 2px;
}
.input::placeholder { color: var(--hint); opacity: 1; }
textarea.input { min-height: 7.5em; resize: vertical; }
.input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.input[aria-invalid='true'] { border-color: var(--error); }
.error { min-height: 0; margin: 0; font-size: 13px; color: var(--error); }
.error:empty { display: none; }

.severity { display: flex; margin: 8px 0 0; padding: 0; border: 0; min-width: 0; }
.severity > label {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--sev-idle);
  cursor: pointer;
}
.severity svg { width: 32px; height: 32px; fill: currentColor; opacity: 0.2; }
.severity input:checked + svg { opacity: 1; }
.severity > label:has(input:checked) { color: var(--sev-active); }
.severity input:focus-visible + svg { outline: 2px solid var(--accent); border-radius: 4px; }
.sev-low svg { color: #00C853; }
.sev-medium svg { color: #DFC12A; }
.sev-high svg { color: #F27979; }
.sev-critical svg { color: #E03D3D; }
.sev-blocker svg { color: #8C0101; }

.footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px 12px;
  flex: none;
}
.footer { margin: 0; font-size: 12px; color: var(--hint); }
.powered {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--hint);
  text-decoration: none;
}
.powered:hover { color: var(--text); text-decoration: underline; }
.powered:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.powered svg { display: block; height: 14px; width: auto; }

.confirm {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  background: var(--page);
}
.confirm[hidden] { display: none; }
.confirm h3 { margin: 0; font-size: 20px; color: var(--text); }
.confirm p { margin: 0; font-size: 16px; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
.confirm-actions button {
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
  color: var(--hint);
}
.confirm-actions .danger { color: var(--accent); }

/* On a phone-sized viewport the card is the mobile SDKs' full-screen form. */
@media (max-width: 480px) {
  .overlay { padding: 0; }
  .card { width: 100%; height: 100%; border-radius: 0; }
}
@media (prefers-reduced-motion: no-preference) {
  .overlay[open] .card { animation: card-in 120ms ease-out; }
  @keyframes card-in { from { opacity: 0; transform: translateY(8px); } }
}
`;
