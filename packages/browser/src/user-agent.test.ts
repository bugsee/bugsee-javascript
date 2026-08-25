import { describe, expect, it } from 'vitest';
import {
  detectBrowser,
  detectOs,
  normalizeUaDataPlatform,
  parseBrowserFromUserAgent,
  parseOsFromUserAgent,
} from './user-agent';

// Real user-agent strings, copied verbatim from the browsers they name. Synthetic UAs would let a
// parser pass against a shape no browser actually emits, which is the whole failure mode here.
const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chromeLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.2151.58',
  operaWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 OPR/104.0.0.0',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.2; rv:121.0) Gecko/20100101 Firefox/121.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  // Headless Chromium — what Playwright/Puppeteer and every CI browser run as. Note it carries
  // `HeadlessChrome/`, NOT `Chrome/`, and still ends in `Safari/537.36`.
  headlessChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36',
  // Chrome and Firefox on iOS: both are WebKit underneath and identify with their own tokens.
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.109 Mobile/15E148 Safari/604.1',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/605.1.15',
  windows7:
    'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
  windows81:
    'Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
};

describe('parseOsFromUserAgent', () => {
  it.each([
    ['chromeMac', UA.chromeMac, 'macos', '10.15.7'],
    ['chromeWin', UA.chromeWin, 'windows', '10'],
    ['chromeLinux', UA.chromeLinux, 'linux', ''],
    ['chromeAndroid', UA.chromeAndroid, 'android', '14'],
    ['chromeOs', UA.chromeOs, 'chromeos', '14541.0.0'],
    ['firefoxMac', UA.firefoxMac, 'macos', '14.2'],
    ['safariIphone', UA.safariIphone, 'ios', '17.1'],
    ['safariIpad', UA.safariIpad, 'ios', '16.6'],
    ['windows7', UA.windows7, 'windows', '7'],
    ['windows81', UA.windows81, 'windows', '8.1'],
  ])('reads %s as the OS it actually runs on', (_name, ua, type, version) => {
    expect(parseOsFromUserAgent(ua)).toEqual({ type, version });
  });

  it('reads Android BEFORE Linux — an Android UA contains the literal "Linux"', () => {
    // The single most likely ordering bug in a UA parser: `Mozilla/5.0 (Linux; Android 14; …)`
    // matches /linux/i, so a naive chain reports every phone on earth as a Linux desktop.
    expect(UA.chromeAndroid).toContain('Linux');
    expect(parseOsFromUserAgent(UA.chromeAndroid).type).toBe('android');
  });

  it('never reads the unversioned "like Mac OS X" phrase as macOS', () => {
    // An iOS UA contains the literal `Mac OS X`, so it LOOKS like the same ordering hazard Android
    // poses for Linux. It is not, and the honest reason matters: the phrase there is `like Mac OS X`
    // with NO version after it, and the macOS rule requires a version token. That requirement — not
    // the order of the checks — is what keeps iPhones from being reported as Macs. Pinned here
    // because loosening the macOS pattern to a bare /Mac OS X/ is the tempting simplification, and
    // the ordering would only mask it for as long as iOS keeps being tested first.
    expect(UA.safariIphone).toContain('Mac OS X');
    expect(/Mac OS X \d/.test(UA.safariIphone)).toBe(false);
    expect(parseOsFromUserAgent('Mozilla/5.0 (Something; like Mac OS X) Gecko').type).not.toBe(
      'macos',
    );
    expect(parseOsFromUserAgent(UA.safariIphone).type).toBe('ios');
  });

  it('reads a CrOS agent as ChromeOS, which no Linux rule could do for it', () => {
    // Also not an ordering hazard, despite looking like one: a CrOS UA carries `X11` but never the
    // word `Linux`, so the generic Linux rule cannot match it either way. What is load-bearing is
    // that the CrOS rule exists at all — without it a Chromebook falls through to unknown.
    expect(/\bLinux\b/.test(UA.chromeOs)).toBe(false);
    expect(parseOsFromUserAgent(UA.chromeOs)).toEqual({ type: 'chromeos', version: '14541.0.0' });
  });

  it('recognises a bare "Macintosh" with no version token, and says the version is unknown', () => {
    // Reduced and embedded agents (trimmed WebViews, some Electron builds) keep the `Macintosh`
    // hardware token while dropping `Mac OS X <version>`. Naming the OS with an empty version beats
    // reporting no OS, and beats inventing one.
    expect(parseOsFromUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36')).toEqual({
      type: 'macos',
      version: '',
    });
  });

  it('returns an EMPTY type for a user agent it cannot place, never a guess', () => {
    // An unknown OS must be reported as unknown. Defaulting to any real OS name would put a
    // fabricated value into the field the backend indexes as os_version's partner.
    expect(parseOsFromUserAgent('Mozilla/5.0 (Nintendo WiiU)')).toEqual({ type: '', version: '' });
    expect(parseOsFromUserAgent('')).toEqual({ type: '', version: '' });
  });

  it('yields the OS version with dots, not the underscores the UA uses', () => {
    expect(parseOsFromUserAgent(UA.chromeMac).version).toBe('10.15.7');
    expect(parseOsFromUserAgent(UA.safariIphone).version).toBe('17.1');
  });
});

describe('parseBrowserFromUserAgent', () => {
  it.each([
    ['chromeMac', UA.chromeMac, 'Chrome', '119.0.0.0'],
    ['chromeAndroid', UA.chromeAndroid, 'Chrome', '119.0.0.0'],
    ['edgeWin', UA.edgeWin, 'Edge', '119.0.2151.58'],
    ['operaWin', UA.operaWin, 'Opera', '104.0.0.0'],
    ['samsungAndroid', UA.samsungAndroid, 'Samsung Internet', '23.0'],
    ['firefoxWin', UA.firefoxWin, 'Firefox', '121.0'],
    ['safariMac', UA.safariMac, 'Safari', '17.1'],
    ['safariIphone', UA.safariIphone, 'Safari', '17.1'],
    ['headlessChrome', UA.headlessChrome, 'Chrome', '151.0.7922.34'],
    ['chromeIos', UA.chromeIos, 'Chrome', '119.0.6045.109'],
    ['firefoxIos', UA.firefoxIos, 'Firefox', '121.0'],
  ])('reads %s as the browser it actually is', (_name, ua, type, version) => {
    expect(parseBrowserFromUserAgent(ua)).toEqual({ type, version });
  });

  it('reads Edge, Opera and Samsung BEFORE Chrome — every Chromium UA contains "Chrome/"', () => {
    // Each of these carries a `Chrome/<version>` token for compatibility, so a chain that tests
    // Chrome first reports all of them as Chrome, at the Chromium version rather than their own.
    for (const ua of [UA.edgeWin, UA.operaWin, UA.samsungAndroid]) {
      expect(ua).toContain('Chrome/');
      expect(parseBrowserFromUserAgent(ua).type).not.toBe('Chrome');
    }
    expect(parseBrowserFromUserAgent(UA.edgeWin).version).toBe('119.0.2151.58'); // Edge's, not 119.0.0.0
    expect(parseBrowserFromUserAgent(UA.operaWin).version).toBe('104.0.0.0'); // Opera's, not 118.0.0.0
    expect(parseBrowserFromUserAgent(UA.samsungAndroid).version).toBe('23.0'); // Samsung's, not 115.0.0.0
  });

  it('reads Chrome BEFORE Safari — every Chromium UA also ends in "Safari/537.36"', () => {
    expect(UA.chromeMac).toContain('Safari/');
    expect(parseBrowserFromUserAgent(UA.chromeMac).type).toBe('Chrome');
  });

  it('takes Safari’s version from the Version/ token, not from Safari/', () => {
    // `Safari/605.1.15` is the WebKit build, not the browser version anyone means by "Safari 17".
    expect(UA.safariMac).toContain('Safari/605.1.15');
    expect(parseBrowserFromUserAgent(UA.safariMac).version).toBe('17.1');
  });

  it('does not mistake HeadlessChrome for Safari — `\\bChrome/` cannot match inside it', () => {
    // Caught by a real staging run, not by this suite: the sweep's own headless browser was arriving
    // as `browser: {type: 'Safari', version: ''}`. `HeadlessChrome/` contains no word boundary before
    // `Chrome`, so the Chrome rule missed it and the trailing `Safari/537.36` claimed it — with an
    // empty version, because a Chromium agent carries no `Version/` token. This is what every
    // Playwright/Puppeteer/CI browser reports.
    expect(/\bChrome\//.test(UA.headlessChrome)).toBe(false);
    expect(UA.headlessChrome).toContain('Safari/537.36');
    expect(parseBrowserFromUserAgent(UA.headlessChrome)).toEqual({
      type: 'Chrome',
      version: '151.0.7922.34',
    });
  });

  it('reads the iOS browsers by their own tokens, not as the WebKit they wrap', () => {
    // Every browser on iOS is WebKit and every one ends in `Safari/`, so CriOS/FxiOS have to be
    // matched explicitly or they all read as Safari.
    expect(parseBrowserFromUserAgent(UA.chromeIos).type).toBe('Chrome');
    expect(parseBrowserFromUserAgent(UA.firefoxIos).type).toBe('Firefox');
    // ...while genuine Safari on the same OS still reads as Safari.
    expect(parseBrowserFromUserAgent(UA.safariIphone).type).toBe('Safari');
  });

  it('returns an EMPTY type for a user agent it cannot place, never a guess', () => {
    expect(parseBrowserFromUserAgent('Mozilla/5.0 (Nintendo WiiU)')).toEqual({
      type: '',
      version: '',
    });
    expect(parseBrowserFromUserAgent('')).toEqual({ type: '', version: '' });
  });

  it('names browsers so the viewer’s lowercased icon lookup resolves', () => {
    // elements-recording-context.component.ts does `browser.type.toLowerCase()` and renders it as a
    // Font Awesome brand class, so the NAME is load-bearing, not cosmetic.
    expect(parseBrowserFromUserAgent(UA.chromeMac).type.toLowerCase()).toBe('chrome');
    expect(parseBrowserFromUserAgent(UA.firefoxWin).type.toLowerCase()).toBe('firefox');
    expect(parseBrowserFromUserAgent(UA.safariMac).type.toLowerCase()).toBe('safari');
    expect(parseBrowserFromUserAgent(UA.edgeWin).type.toLowerCase()).toBe('edge');
    expect(parseBrowserFromUserAgent(UA.operaWin).type.toLowerCase()).toBe('opera');
  });
});

describe('normalizeUaDataPlatform', () => {
  it.each([
    ['macOS', 'macos'],
    ['Windows', 'windows'],
    ['Linux', 'linux'],
    ['Android', 'android'],
    ['iOS', 'ios'],
    ['Chrome OS', 'chromeos'],
    ['Chromium OS', 'chromeos'],
  ])('maps the UA-CH platform %s onto the wire name %s', (input, expected) => {
    expect(normalizeUaDataPlatform(input)).toBe(expected);
  });

  it('returns undefined for "Unknown" and for anything it does not recognise', () => {
    // UA-CH explicitly reports "Unknown"; treating that as an OS name would be worse than the UA
    // parse it would override.
    expect(normalizeUaDataPlatform('Unknown')).toBeUndefined();
    expect(normalizeUaDataPlatform('')).toBeUndefined();
    expect(normalizeUaDataPlatform('Haiku')).toBeUndefined();
  });
});

describe('detectOs — UA-CH preferred for the NAME, user agent for the version', () => {
  it('takes the OS name from UA-CH when it is available', () => {
    // navigator.userAgentData.platform is declared by the browser rather than parsed out of a string,
    // so where it exists it is authoritative for the name.
    expect(detectOs(UA.chromeMac, 'macOS')).toEqual({ type: 'macos', version: '10.15.7' });
  });

  it('still takes the VERSION from the user agent — UA-CH exposes none synchronously', () => {
    // The platform VERSION lives behind getHighEntropyValues(), which is async; the environment is
    // built synchronously at launch, so the UA string remains the only sync source.
    expect(detectOs(UA.chromeWin, 'Windows').version).toBe('10');
  });

  it('falls back to the parsed OS when UA-CH is absent (Firefox, Safari)', () => {
    expect(detectOs(UA.firefoxMac, undefined)).toEqual({ type: 'macos', version: '14.2' });
    expect(detectOs(UA.safariIphone, undefined)).toEqual({ type: 'ios', version: '17.1' });
  });

  it('prefers UA-CH over a DISAGREEING user agent', () => {
    // The case that motivates preferring it at all: a spoofed or reduced UA string against a
    // first-party platform declaration.
    expect(detectOs(UA.chromeWin, 'Linux').type).toBe('linux');
  });

  it('ignores an unrecognised UA-CH platform rather than emitting it raw', () => {
    expect(detectOs(UA.chromeMac, 'Unknown').type).toBe('macos');
    expect(detectOs(UA.chromeMac, 'Haiku').type).toBe('macos');
  });
});

describe('detectBrowser', () => {
  it('reads the browser identity from the user agent', () => {
    expect(detectBrowser(UA.chromeMac)).toEqual({ type: 'Chrome', version: '119.0.0.0' });
  });
});
