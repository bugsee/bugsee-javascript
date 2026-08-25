// OS + browser identification for the web tier, done IN THE BROWSER.
//
// The web tier used to send `platform.type: 'web'` and the whole user-agent string as
// `platform.version`, deferring the parse to the backend. Every other Bugsee SDK reports the OS in
// that pair — iOS/Android send the OS name, the Rust SDK sends macos/linux/windows, and the backend
// indexes `platform.version` as `os_version` — so a browser session was the only kind that yielded
// no operating system at all, and carried a UA string in a version field instead
// (samples/FINDINGS.md F-X20).
//
// Two sources, used for what each is actually good for:
//
//   - `navigator.userAgentData.platform` (UA-CH) is DECLARED by the browser rather than scraped out
//     of a string, so where it exists it is authoritative for the OS NAME. It is Chromium-only,
//     which is the majority of usage but nowhere near all of it.
//   - The user-agent string is the universal fallback, and the only SYNCHRONOUS source of the OS
//     VERSION on any browser: UA-CH puts `platformVersion` behind `getHighEntropyValues()`, which is
//     async, and the environment envelope is built synchronously at launch.
//
// So: name from UA-CH when present, else parsed; version always parsed. Both parsers return an empty
// `type` for anything they cannot place — an unrecognised agent must read as unknown rather than be
// rounded to whichever OS happens to be first in the chain.
//
// On the fragility that motivated deferring this to the backend in the first place: UA reduction
// FROZE the parts used here rather than removing them. Chrome pins `Mac OS X 10_15_7` and
// `Windows NT 10.0` and keeps the Android major version; the tokens are less INFORMATIVE than they
// were, but they are more stable than they have ever been. What reduction does cost us is precision
// (a Windows 11 machine reports `Windows NT 10.0`, and every recent macOS reports 10.15.7), and that
// is a better failure than reporting no OS at all.

/** An OS or browser identity: a wire name and a version, either of which may be '' when unknown. */
export interface Identity {
  type: string;
  version: string;
}

const UNKNOWN: Identity = { type: '', version: '' };

/**
 * `Windows NT <n>` → the marketing name. Windows 10 and 11 are INDISTINGUISHABLE here — UA reduction
 * froze the token at `10.0` for both — so 11 is deliberately reported as "10" rather than guessed.
 * Resolving that needs `getHighEntropyValues(['platformVersion'])`, which is async.
 */
const WINDOWS_NT_VERSIONS: Record<string, string> = {
  '10.0': '10',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
  '6.0': 'Vista',
  '5.1': 'XP',
};

/** UA-CH `platform` values (the full documented set) → the wire's OS names. */
const UA_DATA_PLATFORMS: Record<string, string> = {
  macos: 'macos',
  windows: 'windows',
  linux: 'linux',
  android: 'android',
  ios: 'ios',
  'chrome os': 'chromeos',
  'chromium os': 'chromeos',
};

/**
 * Map a `navigator.userAgentData.platform` value onto the wire's OS vocabulary.
 *
 * Undefined for "Unknown" (which UA-CH reports explicitly) and for anything unrecognised, so the
 * caller falls back to the UA parse instead of putting an unmapped string into the OS field.
 */
export function normalizeUaDataPlatform(platform: string): string | undefined {
  return UA_DATA_PLATFORMS[platform.trim().toLowerCase()];
}

/**
 * The OS a user-agent string describes.
 *
 * ORDER IS THE WHOLE ALGORITHM, and each rule below exists because the naive order is wrong:
 * an Android UA reads `(Linux; Android 14; …)` and matches /linux/; an iPhone UA says
 * `like Mac OS X` and matches /mac os/; a ChromeOS UA is an X11 one. Specific before general.
 */
export function parseOsFromUserAgent(userAgent: string): Identity {
  // iOS first: iPhone/iPad UAs claim `like Mac OS X`. iPadOS reports `CPU OS`, iPhone `CPU iPhone OS`.
  const ios = /(?:iPhone|iPad|iPod).*?CPU (?:iPhone )?OS (\d+(?:[._]\d+)*)/.exec(userAgent);
  if (ios?.[1] !== undefined) {
    return { type: 'ios', version: ios[1].replace(/_/g, '.') };
  }
  // Android before Linux: the token is literally `Linux; Android <v>`.
  const android = /Android (\d+(?:\.\d+)*)/.exec(userAgent);
  if (android?.[1] !== undefined) {
    return { type: 'android', version: android[1] };
  }
  // ChromeOS before Linux: `X11; CrOS <arch> <version>`.
  const cros = /CrOS \S+ (\d+(?:\.\d+)*)/.exec(userAgent);
  if (cros?.[1] !== undefined) {
    return { type: 'chromeos', version: cros[1] };
  }
  const windows = /Windows NT (\d+(?:\.\d+)?)/.exec(userAgent);
  if (windows?.[1] !== undefined) {
    return { type: 'windows', version: WINDOWS_NT_VERSIONS[windows[1]] ?? windows[1] };
  }
  // Chrome/Safari write `Mac OS X 10_15_7`; Firefox writes `Mac OS X 14.2`. Accept both separators.
  const mac = /Mac OS X (\d+(?:[._]\d+)*)/.exec(userAgent);
  if (mac?.[1] !== undefined) {
    return { type: 'macos', version: mac[1].replace(/_/g, '.') };
  }
  if (/\bLinux\b/.test(userAgent)) {
    // A desktop Linux UA carries no distribution or kernel version — only the word. An empty version
    // is the honest answer; the OS name alone is still worth having.
    return { type: 'linux', version: '' };
  }
  // Bare `Macintosh` with no version token (some reduced/embedded agents).
  if (/Macintosh/.test(userAgent)) {
    return { type: 'macos', version: '' };
  }
  return UNKNOWN;
}

/**
 * The browser a user-agent string describes.
 *
 * ORDER IS AGAIN THE ALGORITHM: every Chromium derivative carries a `Chrome/<version>` token for
 * compatibility, and every Chromium UA ends in `Safari/537.36`. Testing Chrome first labels Edge,
 * Opera and Samsung Internet as Chrome AND reports the underlying Chromium version instead of
 * theirs; testing Safari first labels all of them Safari.
 *
 * The names are the ones the viewer lowercases into a Font Awesome brand class
 * (`elements-recording-context.component.ts` → `fa-chrome`, `fa-firefox`, …), so they are
 * load-bearing rather than cosmetic.
 */
export function parseBrowserFromUserAgent(userAgent: string): Identity {
  const derivatives: Array<[RegExp, string]> = [
    [/\bEdg(?:e|A|iOS)?\/(\d+(?:\.\d+)*)/, 'Edge'],
    [/\bOPR\/(\d+(?:\.\d+)*)/, 'Opera'],
    [/\bOpera\/(\d+(?:\.\d+)*)/, 'Opera'],
    [/\bSamsungBrowser\/(\d+(?:\.\d+)*)/, 'Samsung Internet'],
    // The iOS browsers: every one of them is WebKit and ends in `Safari/`, so each needs its own
    // token or they all read as Safari. Reported under their real names — a `CriOS` session IS Chrome.
    [/\bCriOS\/(\d+(?:\.\d+)*)/, 'Chrome'],
    [/\bFxiOS\/(\d+(?:\.\d+)*)/, 'Firefox'],
    [/\bFirefox\/(\d+(?:\.\d+)*)/, 'Firefox'],
    // `HeadlessChrome/` BEFORE `Chrome/`, and note it would not match the Chrome rule anyway: there is
    // no word boundary between `Headless` and `Chrome`, so `\bChrome/` skips straight past it and the
    // trailing `Safari/537.36` used to claim the session — reporting every Playwright/Puppeteer/CI
    // browser as "Safari" with an empty version. Found by a real staging run, not by a unit test.
    // Named plain 'Chrome' rather than 'Headless Chrome' because the viewer lowercases this value
    // into a Font Awesome class, and a space would produce a broken one.
    [/\bHeadlessChrome\/(\d+(?:\.\d+)*)/, 'Chrome'],
    [/\bChrome\/(\d+(?:\.\d+)*)/, 'Chrome'],
  ];
  for (const [pattern, name] of derivatives) {
    const match = pattern.exec(userAgent);
    if (match?.[1] !== undefined) {
      return { type: name, version: match[1] };
    }
  }
  // Safari last, and its version comes from `Version/`, not `Safari/` — the latter is the WebKit
  // build number (605.1.15), not the browser version anyone means by "Safari 17".
  if (/\bSafari\/\d/.test(userAgent)) {
    const version = /\bVersion\/(\d+(?:\.\d+)*)/.exec(userAgent);
    return { type: 'Safari', version: version?.[1] ?? '' };
  }
  return UNKNOWN;
}

/**
 * The OS: name from UA-CH where the browser declares one, version always from the user agent.
 *
 * When UA-CH names an OS the UA string disagrees with, UA-CH wins — it is a first-party declaration
 * against a string anything can rewrite. The version still comes from the UA parse (the only sync
 * source), which is why a disagreement can yield a name and version from different sources; that is
 * accepted deliberately, because the name is the field consumers key on.
 */
export function detectOs(userAgent: string, uaDataPlatform: string | undefined): Identity {
  const parsed = parseOsFromUserAgent(userAgent);
  const declared =
    uaDataPlatform === undefined ? undefined : normalizeUaDataPlatform(uaDataPlatform);
  return declared === undefined ? parsed : { type: declared, version: parsed.version };
}

/** The browser identity. UA-CH's `brands` carries only a major version, so the UA string is better. */
export function detectBrowser(userAgent: string): Identity {
  return parseBrowserFromUserAgent(userAgent);
}
