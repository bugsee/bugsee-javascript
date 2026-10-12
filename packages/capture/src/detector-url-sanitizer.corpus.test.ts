import { describe, expect, it } from 'vitest';
import {
  LENGTH_BUCKETS,
  mulberry32,
  randomTokens,
  routeCorpus,
  TOKEN_ALPHABETS,
} from './detector-url-corpus.test-d';
import { templatePathSegment } from './detector-url-sanitizer';

// The word check counted any run of three lower-case letters as a word, so lower-case random tokens (cuid2,
// base32, nanoid, ULID, base36) were kept verbatim. A single-case string with no separator is never word-like; a
// camel/Pascal identifier needs two Title-case pieces that can each be pronounced; a slug needs pronounceable pieces.
describe('templatePathSegment: lower-case random tokens are never "words" (R5V-1)', () => {
  it.each([
    'clh3am4pu0000qfw9rg5d1zk', // cuid2, 24
    'tz4a98xxat96iws9zmbrgj3a', // cuid2-shaped, 24
    'jbswy3dpehpk3pxp2yvoqzlk4a', // base32 lower, 26
    '01arz3ndektsv4rrffq69g5fav', // ULID lower, 26
    'v1stgxr8z5jdhi6bmyt3k', // nanoid lower, 21
    'k3j4h5g6f7d8s9a0q1w2e3r4t5y6', // base36 lower, 28
    // English words but no separator and no case change: not provably words (privacy over grouping)
    'getuserdetailsandsettings2',
    'updatenotificationsettings3',
    'abcdefgh1abcdefgh2', // two plain words with a number between, no separator (was kept as "words" in)
    'CLH3AM4PU0000QFW9RG5D1ZK',
    'GETUSERDETAILSANDSETTINGS2',
  ])('templates the single-case string %j', (segment) => {
    expect(templatePathSegment(segment)).toMatch(/^\{(token|id)\}$/);
  });

  it.each([
    'getUserDetailsV2',
    'getAllUserNotificationSettingsV2',
    'UpdateCartItemQuantityMutation',
    'OnOrderStatusChangedSubscription',
    'XMLHttpRequestHandler2',
    'getHtmlPageForWorkspaceV2',
    'queueMessageRetryPolicy2',
    'getUserConfigurationV2',
    'getUserAuthenticationV2',
    'getUserStrengthsAndLengthsV2',
    'getWishlistSettingsV2', // `sh` + `l` is two sounds
    'getNewsletterShortcutV2',
    'bootstrapEnrollmentPlanV2',
    'getLayoutPayoutPlayerV2', // `y` ends a vowel run
    'WEBGLContextCanvasV2', // a known abbreviation of 5 letters counts as part of the name
    'getUserDetailsAndSettingsV2-', // a trailing separator is not a second piece
    'getUserSynthsPageV2', // a run after a `y` starts after it
    'getUserSettingsFA123', // a two-letter acronym counts toward the 80% (words alone are 75%)
    'NOTIFICATION_MIDDLEWARE2', // upper-case slug words
  ])('keeps the identifier %j (>= 2 pronounceable Title-case pieces)', (segment) => {
    expect(templatePathSegment(segment)).toBe(segment);
  });

  it.each([
    ['getXkqzvbnDetailsV2', 'a Title piece nobody can pronounce'],
    ['getUserDetailsqzxwvV2', 'a consonant run that is not a known cluster'],
    ['getUserDetailsq9Zk', 'a q without a u'],
    ['aeiouaeiouGetUserSettings2', 'a four-vowel run that is not a known cluster'],
    ['getUserInternationalizationalizationV2', 'a piece too long to be one word'],
    ['getUserBcdfgSettingsV2', 'a piece without a vowel that is not a known abbreviation'],
    ['getUserAeiouSettingsV2', 'a piece made only of vowels'],
    ['Report1X9Q2K7Z4Detail', 'too many separate numbers'],
    ['getUserDetails12345V2', 'a number longer than four digits'],
    ['xGetUserSettingsAbCdEfGh2', 'two stray fragments'],
    ['getUser~DetailsPageV2', 'a tilde is not part of a name'],
    ['getUserCkshPageV2', 'a piece with no vowel that is not a known abbreviation'],
    ['getUserIouSettingsV2', 'a piece that is all vowels'],
    ['Settings12Report3Zk', 'words cover less than 80% of the name'],
    ['configurationCsvPdfV2', 'one long word and two 3-letter pieces: fewer than two real words'],
    ['getUserSettingsPageListXkAbV2', 'two stray fragments'],
    ['x1-y2-z3-configurationEngine', 'one word among three codes'],
    [
      'user2page3-user2page3',
      'a slug piece needs a Title word or a plain word, not two words split by numbers',
    ],
    ['QzRzuIFDixAWONV9', 'acronyms nobody recognises do not make a name (measured: base62 leak)'],
    ['IvmwRkbu53HUemzwB4', 'pieces that are pronounceable only by luck (measured: base62 leak)'],
  ])('%j is a token: %s', (segment) => {
    expect(templatePathSegment(segment)).toMatch(/^\{(token|id)\}$/);
  });

  it('a slug is word-like only when its pieces are short and pronounceable', () => {
    expect(templatePathSegment('release-notes-2024')).toBe('release-notes-2024');
    expect(templatePathSegment('privacy-policy-archive2')).toBe('privacy-policy-archive2');
    expect(templatePathSegment('xkqzvbn-plmrtgh-wsdfrt-9')).toBe('{token}');
    expect(templatePathSegment('zxcvbnmqwrt-asdfghjkl1-poiuytrewq')).toBe('{token}');
    // a piece of 13+ letters is not a word, and a number-only slug has no word at all
    expect(templatePathSegment('authentication_middleware2')).toBe('{token}'); // 14 letters
    expect(templatePathSegment('notification_middleware2')).toBe('notification_middleware2'); // 12 and 10
    expect(templatePathSegment('2024-2025-2026-2027-v1-v2-q1')).toBe(
      '2024-2025-2026-2027-v1-v2-q1',
    );
  });

  // The acceptance numbers. Deterministic: the same seed produces the same tokens, so a figure is a fact, not luck.
  // Ceilings are the (a98dabb, no word check at all) keep rates measured on THIS corpus (same seed,
  // 20,000 tokens a bucket), rounded up to 0.05. The word check may not raise a bucket above them (two base62
  // buckets sit one token in 20,000 above the measured a98dabb figure, inside the rounding). Where the review named
  // a figure it is used as is: base36-lower 24-31 <= 0.1%, cuid2 24-31 <= 0.2%, base32-lower 24-31 <= 1%.
  // Percent of tokens kept verbatim; columns are LENGTH_BUCKETS.
  const CEILINGS: Record<string, readonly number[]> = {
    base64url: [5.6, 3.7, 2.45, 1.2, 0.25, 0.05],
    base62: [4.55, 2.95, 1.98, 0.9, 0.17, 0.01],
    hex: [0, 0, 0, 0, 0, 0],
    'base36-lower': [4.1, 1.7, 1.05, 0.1, 0.01, 0.01],
    'base36-upper': [4.1, 1.7, 1.05, 0.1, 0.01, 0.01],
    'base32-lower': [16.3, 10.3, 7.2, 1.0, 0.06, 0.01],
    cuid2: [5.52, 2.25, 1.32, 0.2, 0.01, 0.01],
    'ulid-lower': [2.22, 0.82, 0.42, 0.1, 0.01, 0.01],
    'nanoid-lower': [5.4, 2.42, 1.57, 0.1, 0.01, 0.01],
  };

  it('has a ceiling for every alphabet and every length bucket', () => {
    expect(Object.keys(CEILINGS).sort()).toEqual(TOKEN_ALPHABETS.map((a) => a.name).sort());
    for (const ceilings of Object.values(CEILINGS)) {
      expect(ceilings).toHaveLength(LENGTH_BUCKETS.length);
    }
  });

  describe.each(
    TOKEN_ALPHABETS.map((a) => [a.name, a] as const),
  )('keep rate of %s tokens', (name, alphabet) => {
    const next = mulberry32(0xc0ffee);
    it.each(
      LENGTH_BUCKETS.map((b, index) => [b.name, b, index] as const),
    )('length %s', (_label, bucket, index) => {
      const tokens = randomTokens(alphabet, bucket, 20_000, next);
      let kept = 0;
      for (const token of tokens) {
        if (templatePathSegment(token) === token) {
          kept += 1;
        }
      }
      expect((100 * kept) / tokens.length).toBeLessThanOrEqual(
        (CEILINGS[name] as readonly number[])[index] as number,
      );
    });
  });

  it('wrongly templates at most 15% of 3,000 realistic route segments (every one 16+ characters)', () => {
    const routes = routeCorpus(3000);
    expect(routes).toHaveLength(3000);
    expect(routes.every((route) => route.segment.length >= 16)).toBe(true);
    expect(new Set(routes.map((route) => route.family)).size).toBe(9); // every family is represented
    const wrong = routes.filter((route) => templatePathSegment(route.segment) !== route.segment);
    expect(wrong.length / routes.length).toBeLessThanOrEqual(0.15);
  });
});

// /.
describe('templatePathSegment: e-mail on ANY @, but a version or an @2x asset is not an address (R5V-2/3)', () => {
  it.each([
    'react@latest',
    'pkg@next',
    'react@18.2.0',
    'react@18',
    'lodash@4.17.21',
    'logo@2x.png',
    'icon@3x.webp',
  ])('keeps the spec %j', (segment) => {
    expect(templatePathSegment(segment)).toBe(segment);
  });

  it.each([
    '@alice@example.com',
    '%40alice%40example.com',
    'alice@example.com@latest',
    'jane.doe@corp.com@next',
    'alice@example.com@',
    'alice@example.com@x',
    'alice@example.com@%20',
    'alice@example.com@2x.png',
    'user@v2.example.com',
    'user@2x.example.com',
    'alice@example.com',
    'a@b.c@x', // the dot sits exactly two characters after the first @
    'x@a1.b',
    'react@next@corp.com',
    'a@b@localhost',
  ])('templates %j', (segment) => {
    expect(templatePathSegment(segment)).toBe('{email}');
  });

  it.each([
    '@',
    '@alice',
    'alice@',
    'a@b',
    'react@next@latest',
  ])('is not an address: %j', (segment) => {
    expect(templatePathSegment(segment)).toBe(segment);
  });

  it('stays linear with many @ and dots (every @ is a candidate, each judged in constant time)', () => {
    expect(templatePathSegment('@a.'.repeat(80))).toBe('{email}');
    expect(templatePathSegment('@'.repeat(256))).toBe('@'.repeat(256));
    expect(templatePathSegment(`${'a@'.repeat(127)}bc`)).toBe('{email}');
  });
});

// the cheap misses.
describe('templatePathSegment: addresses, phones and hashed assets (R5V-10)', () => {
  it.each([
    ['10.0.0.1:8080', '{ip}'],
    ['192.168.1.1:443', '{ip}'],
    ['[::1]', '{ip}'],
    ['[::1]:3000', '{ip}'],
    ['[2001:db8::1]:8443', '{ip}'],
    ['tel:+14155550123', 'tel:{phone}'],
    ['tel:%2B14155550123', 'tel:{phone}'],
    ['alice%2540example.com', '{email}'],
    ['%2540alice%2540example.com', '{email}'],
    ['bundle.068e178e.jpg', 'bundle.{token}.jpg'],
    ['main.3f9a2c1b.chunk.js', 'main.{token}.chunk.js'],
    ['logo.5f2b8c1d9e3a7b40.png', 'logo.{hex}.png'],
    ['vendors~main.abc123def456.js', 'vendors~main.{token}.js'],
  ])('%j -> %j', (segment, expected) => {
    expect(templatePathSegment(segment)).toBe(expected);
  });

  it.each([
    'localhost:8080',
    'host.test:8080',
    '10.0.0.1:notaport',
    '10.0.0.1:123456',
    '[::1',
    '[::1]x',
    '[::1]:abc',
    '[host]:80',
    'tel:',
    'tel:abc',
    'tel:+1',
    'bundle.deadbeef.jpg', // letters only: not provably a hash
    'jquery.min.js',
    'chunk-3a9f.js',
    '%2540',
  ])('does not touch %j', (segment) => {
    expect(templatePathSegment(segment)).toBe(segment);
  });
});

// R6V: numberless 24+ tokens (`sk-` + letters) and 16-23 character lower-case tokens with a single digit run were
// kept 200/200. Seeded, so the figures are facts. Both corpora are random letters, never words.
describe('templatePathSegment: numberless long tokens and single-digit short tokens (R6V)', () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const pick = (next: () => number, n: number): string => {
    let out = '';
    for (let i = 0; i < n; i += 1) {
      out += letters.charAt(Math.floor(next() * 26));
    }
    return out;
  };

  it('templates (almost) every `sk-` + 24 random letters, a numberless secret key', () => {
    const next = mulberry32(0x5eed01);
    let kept = 0;
    for (let i = 0; i < 200; i += 1) {
      const token = `sk-${pick(next, 24)}`;
      kept += templatePathSegment(token) === token ? 1 : 0;
    }
    expect(kept).toBe(0); // measured 0/200 (was 200/200)
  });

  it('templates (almost) every 16-23 character lower-case token with a single digit run', () => {
    const next = mulberry32(0x5eed02);
    let kept = 0;
    for (let i = 0; i < 200; i += 1) {
      const length = 16 + Math.floor(next() * 8);
      const at = Math.floor(next() * (length - 1));
      const token = `${pick(next, at)}${1 + Math.floor(next() * 9)}${pick(next, length - at - 1)}`;
      kept += templatePathSegment(token) === token ? 1 : 0;
    }
    expect(kept).toBeLessThanOrEqual(2); // measured 0/200 (was 200/200)
  });

  it.each([
    'getAllUserNotificationSettings',
    'getUserDetailsV2',
    'exportCsvReportV3',
    'HTML5VideoPlayer2',
    'Chapter12Section3',
    'iso-8859-1-encoding',
    'report_2024_q3_final',
    'react@latest',
    'pkg@next',
    'logo@2x.png',
    'ecmascript2015modules',
    'authentication-v2',
  ])('still keeps the name %j', (keep) => {
    expect(templatePathSegment(keep)).toBe(keep);
  });
});
