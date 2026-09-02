// The literals the browser scenario types into the page and the browser e2e asserts on.
//
// They live in their own module because `browser-scenario.ts` runs on import — it touches `window` at
// module scope, which is correct in a page and a `ReferenceError` in the node test process. Importing the
// values from here keeps ONE definition without dragging the page's side effects into the runner.

/** The value typed into the password field. It must not reach ANY byte of ANY uploaded file. */
export const BROWSER_SECRET = 'pw-e2e-MUST-NOT-SHIP-9f3a';
/** The value typed into an ordinary (non-sensitive) field. */
export const BROWSER_VISIBLE_TEXT = 'ordinary-visible-input';
/** Text rendered into the page body, masked by rrweb's `maskAllText`. */
export const BROWSER_BODY_TEXT = 'body-text-e2e-marker';
