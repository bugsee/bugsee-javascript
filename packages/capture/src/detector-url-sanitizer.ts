// URL normalization for detection reports (Android `DetectorUrlSanitizer` parity). A detector's text
// (summary, description, attributes, grouping label) must carry neither PII nor volatile values:
//  - the query string, fragment and `user:pass@` credentials are dropped entirely (that is where tokens
//    live, and keeping them would make every request its own issue);
//  - path segments that look like identifiers or secrets (numeric ids, UUIDs, long hex, base64/JWT-shaped
//    tokens, e-mail addresses, short ids, phone numbers, card numbers, IPs, dates) are templated, so `/users/42/orders/99` and `/users/7/orders/3` are one
//    endpoint and an e-mail address in a path can never reach a summary.
// Android templates only when a network filter is configured; this SDK templates ALWAYS, because the
// default-sanitized timeline is not what a detector reads (it sees the raw event) and a templated path is
// also what makes grouping useful. Recorded under "Kept differences" in.

const ALL_DIGITS = /^[0-9]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Either case: a SHA-1/256 digest or a Mongo id is as often upper-case as lower.
const LONG_HEX = /^[0-9a-fA-F]{16,}$/;
// base64url / JWT-shaped: at least 24 URL-safe token characters including at least one number (the number
// separates real tokens from long all-letter slugs such as `the-quick-brown-fox-jumps`).
const TOKENISH = /^[A-Za-z0-9._~-]{24,}$/;
const HAS_NUMBER = /[0-9]/;
// A mixed-case alphanumeric id of the fixed lengths the common generators emit: nanoid (21), Firebase push
// ids (20). `_` and `-` are in their alphabets.
const SHORT_ID = /^[A-Za-z0-9_-]{20,21}$/;
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
const IPV4 = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;
const IPV6_CHARS = /^[0-9a-fA-F:]+$/;
const IPV4_PORT = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}:[0-9]{1,5}$/;
const PORT_SUFFIX = /^(?::[0-9]{1,5})?$/;
// A content hash of a built asset: webpack's 8-hex `[contenthash:8]` up to the 15 just below LONG_HEX.
const HASH_PIECE = /^[0-9a-fA-F]{8,15}$/;
const HAS_HEX_LETTER = /[a-fA-F]/;
const TEL_PREFIX = /^tel:/i;
// ISO-8601 date, optionally with a time and zone: 2024-01-15, 2024-01-15T10:20:30.123Z, ...+02:00.
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$/;
// A prefix (one short alphanumeric word) + `_`/`-` + 3 or more numbers: `ord_12345`, `user-9981`.
const PREFIX_HEAD = /^[A-Za-z][A-Za-z0-9]{0,15}$/;
const PREFIXED_ID_MIN_LENGTH = 3;
const FILE_EXTENSION = /^\.[A-Za-z][A-Za-z0-9]{0,4}$/;
const SLUG_WORD_PIECE = /^([A-Za-z]{3,12})[0-9]{0,4}$/;
const SLUG_CODE_PIECE = /^(?:[A-Za-z]{1,2}[0-9]{0,4}|[0-9]{1,2}[A-Za-z]{1,3})$/;
const MID_DIGIT = /[0-9][A-Za-z]/;
const VERSION_MARKER = /^[A-Za-z]{1,2}[0-9]{1,2}[A-Za-z]{3,6}[0-9]{0,2}$/;
const MID_DIGIT_WORD_MAX = 8; // `v1beta1`, `covid19x2`: the longest slug word with a number inside it
// Word-likeness. No dictionary: a piece "reads as a word" when it can be pronounced, a cheap test on
// its vowel/consonant structure that real words pass and random letters almost never do. A string with no separator
// and a single case can never be shown to be words (a lower-case cuid2 or base32 id is made of the same letters), so
// only camelCase/PascalCase identifiers and separator-delimited slugs are ever word-like.
const PIECE_FREE_LETTERS = 3; // a slug word's letter run up to this long needs no test (`v`, `xl`, `api`)
const STRAY_MAX_LETTERS = 2; // a camelCase piece this short is a fragment, not a word (`o` in `gpt4oMini`)
const SLUG_LIKE_PIECE_MAX_LETTERS = 20; // a plain 3+ word slug: `internationalization`
const CAMEL_PIECE_MAX_LETTERS = 16; // a Title/lower piece of a camelCase name
const CAMEL_MIN_TITLE_WORDS = 2;
const CAMEL_MAX_STRAY_PIECES = 1; // a 1-2 letter piece that is not an acronym (`gpt4oMini`: the `o`)
const CAMEL_STRONG_WORD_LETTERS = 4;
const CAMEL_MIN_STRONG_WORDS = 2;
const CAMEL_MIN_STRONG_COVERAGE_PERCENT = 60; // of the name made of words of 4+ letters
const CAMEL_MAX_ACRONYMS = 2;
const CAMEL_MIN_COVERAGE_PERCENT = 80; // of the name made of pronounceable words and acronyms (the rest: numbers)
const CAMEL_MAX_DIGIT_RUNS = 3;
const CAMEL_MAX_DIGITS = 4;
const MIN_VOWEL_DENOMINATOR = 9; // at least one vowel in nine letters (`strengths`)
const MAX_VOWEL_PERCENT = 80; // `queue`
const DIGRAPHS = new Set(['sh', 'ch', 'th', 'ph', 'gh', 'ck', 'wh', 'ng']);
/**
 * Consonant runs of 3+ SOUNDS (digraphs count once) that real words contain (`street`, `lengths`, `subscription`,
 * `workspace`). Two in a row are always allowed; a longer run must be one of these. Random letters hit a listed run
 * rarely, which is most of what separates `getUserDetails` from `IvmwRkbu`.
 */
const KNOWN_CONSONANT_CLUSTERS = new Set([
  // three
  'str',
  'spr',
  'spl',
  'scr',
  'shr',
  'thr',
  'chr',
  'sch',
  'phr',
  'nch',
  'tch',
  'rch',
  'lch',
  'nth',
  'rth',
  'lth',
  'nst',
  'rst',
  'lst',
  'mst',
  'ght',
  'ngs',
  'nds',
  'rds',
  'lds',
  'rms',
  'rns',
  'rks',
  'rts',
  'rps',
  'mps',
  'mpt',
  'nts',
  'sts',
  'cts',
  'pts',
  'kts',
  'xts',
  'cks',
  'nks',
  'lks',
  'lps',
  'lms',
  'rnt',
  'rld',
  'rmt',
  'rnd',
  'rbs',
  'rgs',
  'ngl',
  'ngr',
  'ndl',
  'ndr',
  'ntr',
  'nsf',
  'nsp',
  'nsc',
  'mpl',
  'mpr',
  'mbl',
  'mbr',
  'bsc',
  'ctr',
  'xpl',
  'xpr',
  'xtr',
  'ckl',
  'ckn',
  'ckp',
  'ckg',
  'ckb',
  'ldr',
  'ntl',
  'ndw',
  'dsc',
  'rsh',
  'rsp',
  'rtm',
  'rtn',
  'rtr',
  'rgr',
  'rsc',
  'rcl',
  'rpl',
  'rpr',
  'ths',
  'ndt',
  'mbs',
  'tsp',
  'dgm',
  'dgn',
  'ntm',
  'ndm',
  'stm',
  'stl',
  'stn',
  'ltr',
  'wst',
  'rkt',
  'nct',
  'rch',
  'ncl',
  'ncr',
  'ngt',
  'rrl',
  'lsc',
  'xcl',
  'xpt',
  'ftw',
  'ftp',
  'pst',
  'ndp',
  'llm',
  'rtc',
  'nrl',
  'tstr',
  'wsl',
  'rkl',
  'bst',
  'gst',
  'bjc',
  'ldn',
  'ppr',
  'wnl',
  'lts',
  'shb',
  'ddr',
  'ssw',
  'ndc',
  'ndf',
  'ndg',
  'ndb',
  'rdw',
  'rkf',
  'rkg',
  'rkm',
  'rkb',
  'rkt',
  'mbn',
  'ctm',
  'ctp',
  'ctn',
  'ptn',
  'dpr',
  'dcl',
  'ntf',
  'ntg',
  'nfl',
  'nfr',
  'mmr',
  'ngd',
  'ngf',
  'ngp',
  'ngm',
  'ngw',
  'lfl',
  'tsc',
  'tsh',
  'tsm',
  'tsn',
  'ssl',
  'ssn',
  'ssm',
  'ssp',
  'sst',
  'rsn',
  'rsl',
  'rtl',
  'rdr',
  'rdt',
  'rdn',
  'rmn',
  'dst',
  'dsp',
  'dsl',
  'dsm',
  'dvr',
  'bbl',
  'ggl',
  'ppl',
  'ttl',
  'ddl',
  'ffl',
  'kfl',
  'hnl',
  'nsl',
  'nsm',
  'nsn',
  // four and more
  'ngth',
  'ngths',
  'nths',
  'dths',
  'mpts',
  'ghts',
  'ghtw',
  'mphs',
  'rksp',
  'rksh',
  'rkfl',
  'rkgr',
  'bscr',
  'nscr',
  'nstr',
  'bstr',
  'ndsc',
  'ndstr',
  'stscr',
  'rdpr',
  'ckgr',
  'rthd',
  'ntrl',
  'nstl',
  'ctrl',
  'ntsp',
]);
/** Vowel runs of 3+ letters that real words contain (`beautiful`, `previous`, `queue`, `queen`, `seeing`). */
const KNOWN_VOWEL_CLUSTERS = new Set([
  'eau',
  'iou',
  'eou',
  'uou',
  'ieu',
  'uee',
  'ueu',
  'oui',
  'ioa',
  'uai',
  'uie',
  'eei',
  'ooi',
  'aii',
  'aia',
  'ueue',
]);
/** Upper-case abbreviations that appear in route names (`getAPIKeys`, `HTML5VideoPlayer`), beside the vowel-less ones below. */
const KNOWN_ACRONYMS = new Set([
  'api',
  'url',
  'uri',
  'uuid',
  'guid',
  'json',
  'yaml',
  'utf',
  'ascii',
  'rest',
  'soap',
  'jwt',
  'oauth',
  'saml',
  'otp',
  'sdk',
  'sso',
  'ios',
  'aws',
  'gcp',
  'rpc',
  'cpu',
  'gpu',
  'ram',
  'png',
  'gif',
  'jpeg',
  'ssh',
  'iot',
  'seo',
  'cors',
  'csrf',
  'xss',
  'cli',
  'ide',
  'mfa',
  'sms',
  'pdf',
  'svg',
  'html',
  'http',
  'https',
  'xml',
  'sql',
  'css',
  'csv',
  'dns',
  'ssl',
  'tls',
  'tcp',
  'udp',
  'vpn',
  'ftp',
  'smtp',
  'grpc',
  'jsx',
  'tsx',
  'wasm',
  'webgl',
  'crud',
  'ajax',
  'dom',
]);
/** Abbreviations with no vowel (and 3-letter ones) that are routes' bread and butter. */
const VOWELLESS_WORDS = new Set([
  'html',
  'xhtml',
  'shtml',
  'http',
  'https',
  'grpc',
  'rtsp',
  'smtp',
  'sftp',
  'ftps',
  'scss',
  'xmpp',
  'css',
  'csv',
  'xml',
  'sql',
  'gpt',
  'dns',
  'php',
  'cdn',
  'rss',
  'tcp',
  'udp',
  'xhr',
  'jpg',
  'svg',
  'ssl',
  'tls',
  'ftp',
  'nfc',
  'pdf',
  'tsx',
  'jsx',
  'vpn',
  'cts',
  'mjs',
  'cjs',
  'wss',
]);
// A payment card number: 13-19 digits (Maestro to the longest PAN) with `-` or ` ` between the groups.
const CARD_MIN_LENGTH = 13;
const CARD_MAX_LENGTH = 19;
// Random tokens shorter than the 24-character floor above (base64url of 12-17 bytes): 16-23 characters.
const SHORT_TOKEN_MIN_LENGTH = 16;
const SHORT_TOKEN_MAX_LENGTH = 23;
const SHORT_TOKEN_CHARS = /^[A-Za-z0-9._~-]+$/; // the length is bounded separately, above
// A host with no dot (`localhost`, an intranet name): at least two characters, letters/numbers/hyphens.
const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]+$/;
const PHONE_MIN_LENGTH = 7;
const PHONE_MAX_LENGTH = 15;
/** No real identifier is this long; a longer segment is a blob (and was never going to be a readable slug). */
const MAX_SEGMENT_LENGTH = 256;

/** npm/CDN dist-tags: `react@latest` is a package spec, not an address. */
const DIST_TAGS = new Set([
  'latest',
  'next',
  'beta',
  'alpha',
  'canary',
  'rc',
  'nightly',
  'stable',
  'experimental',
]);

// A version (`18.2.0`, `18`) or a retina asset (`2x.png`) after an `@` is a package spec / file name, not a domain.
const VERSION_HOST = /^[0-9.]+$/;
const RETINA_HOST = /^[0-9]+x(?:\.[A-Za-z][A-Za-z0-9]{0,4})?$/; // `logo@2x` is the stem of `logo@2x.png`

/**
 * Whether ANY `@` of the segment (not the first character) yields an address: `@alice@example.com`,
 * `alice@example.com@latest`, `jane.doe@corp.com@next`. One linear pass: a dotted host after a NON-last `@` is an
 * address whatever follows it (the dot test is a single `lastIndexOf`), and the last `@`, whose host contains no `@`,
 * is judged on its own (a version, a retina asset or a dist-tag is a package spec, not a host).
 */
function looksLikeEmail(segment: string): boolean {
  const first = segment.indexOf('@', 1);
  if (first < 0) {
    return false;
  }
  const last = segment.lastIndexOf('@');
  // A dot in the domain part of an earlier `@`, not adjacent to it or to the end.
  if (first !== last && segment.lastIndexOf('.', segment.length - 2) >= first + 2) {
    return true;
  }
  const host = segment.slice(last + 1);
  if (VERSION_HOST.test(host) || RETINA_HOST.test(host)) {
    return false;
  }
  const dot = host.indexOf('.', 1);
  if (dot > 0 && dot < host.length - 1) {
    return true;
  }
  // Or a dot-less host (`user@localhost`): still an address. One character is not a host (`a@b`), and a
  // dist-tag is a package version, not a host.
  return HOST_LABEL.test(host) && !DIST_TAGS.has(host.toLowerCase());
}

/** `10.0.0.1:8080`, `[::1]`, `[2001:db8::1]:8443`: an address with an optional port. */
function looksLikeIpWithPort(segment: string): boolean {
  if (IPV4_PORT.test(segment)) {
    return true;
  }
  const close = segment.indexOf(']');
  if (!segment.startsWith('[') || close < 0) {
    return false;
  }
  return PORT_SUFFIX.test(segment.slice(close + 1)) && looksLikeIp(segment.slice(1, close));
}

/** A file name with a content hash in the middle (`main.3f9a2c1b.chunk`, `bundle.068e178e`): templates the hash only. */
function templateHashedPieces(stem: string): string {
  if (!stem.includes('.')) {
    return stem;
  }
  return stem
    .split('.')
    .map((piece) => {
      if (LONG_HEX.test(piece)) {
        return '{hex}';
      }
      return HASH_PIECE.test(piece) && HAS_NUMBER.test(piece) && HAS_HEX_LETTER.test(piece)
        ? '{token}'
        : piece;
    })
    .join('.');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A slug word: one or two numbers on their own, up to FOUR digits (`2024`, `8859`), or letters with at most two
 * separate runs of one or two numbers (`v2`, `covid19`, `q3`), in one case or Title-cased (`Guide`; never `tnLeEum`). A number BETWEEN letters (`v1beta1`) is only a
 * version marker when the word is short and single-case: `V1StGXR8` and `eyJhbGciOiJIUzI1NiJ9` are token pieces.
 * Linear, no regex.
 */
function isSlugWord(word: string): boolean {
  let digitRuns = 0;
  let upper = 0;
  let lower = 0;
  let run = 0;
  let midDigits = false; // a number that is followed by more letters
  for (let i = 0; i < word.length; i += 1) {
    const code = word.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      run += 1;
      if (run === 1) {
        digitRuns += 1;
      }
      if (run > 2 && !(upper + lower === 0 && run <= 4)) {
        return false;
      }
    } else if (code >= 65 && code <= 90) {
      if (lower > 0) {
        return false; // an internal capital (`tnLeEumGJ`) is camelCase or random, never a slug word
      }
      upper += 1;
      midDigits = midDigits || run > 0;
      run = 0;
    } else if (code >= 97 && code <= 122) {
      lower += 1;
      midDigits = midDigits || run > 0;
      run = 0;
    } else {
      return false;
    }
  }
  if (digitRuns > 2) {
    return false;
  }
  return !midDigits || (word.length <= MID_DIGIT_WORD_MAX && (upper === 0 || lower === 0));
}
/** A consonant run counted in sounds: `sh`, `ch`, `th`, `ph`, `gh`, `ck`, `wh`, `ng` are one each (`wishlist`: `sh` + `l`). */
function consonantUnits(run: string): number {
  let units = 0;
  for (let i = 0; i < run.length; i += 1) {
    units += 1;
    if (DIGRAPHS.has(run.slice(i, i + 2))) {
      i += 1;
    }
  }
  return units;
}

/**
 * Whether a lower-case run of letters can be pronounced: at least one vowel in nine letters and at most 80%
 * vowels, no `q` without a `u`, no letter three times in a row, no consonant run of 3+ and no vowel run of 3+ except
 * the explicit clusters above (`street`, `lengths`, `beautiful`, `queue`). `y` is a vowel for the ratio and ends a run
 * (`layout`, `player`). A known vowel-less abbreviation (`html`) passes. Real words pass; random letters almost never
 * do. Linear.
 */
function isPronounceable(letters: string): boolean {
  if (VOWELLESS_WORDS.has(letters)) {
    return true;
  }
  let vowels = 0;
  let runStart = 0;
  let runIsVowel = false;
  for (let i = 0; i <= letters.length; i += 1) {
    const char = letters.charAt(i); // '' past the end: closes the last run
    const isY = char === 'y';
    const vowel = !isY && char !== '' && 'aeiou'.includes(char);
    if (i === 0 || i === letters.length || isY || vowel !== runIsVowel) {
      const run = letters.slice(runStart, i);
      if (
        run.length >= 3 &&
        (runIsVowel
          ? !KNOWN_VOWEL_CLUSTERS.has(run)
          : consonantUnits(run) >= 3 && !KNOWN_CONSONANT_CLUSTERS.has(run))
      ) {
        return false;
      }
      runStart = isY ? i + 1 : i;
      runIsVowel = vowel;
    }
    vowels += vowel || isY ? 1 : 0;
    if (char === 'q' && letters.charAt(i + 1) !== 'u') {
      return false;
    }
  }
  return (
    vowels * MIN_VOWEL_DENOMINATOR >= letters.length &&
    vowels * 100 <= letters.length * MAX_VOWEL_PERCENT
  );
}

/** A word of 3+ letters: no longer than `max` and pronounceable (a 3-letter one needs a vowel or to be a known abbreviation). */
function isWordPiece(piece: string, max: number): boolean {
  return piece.length <= max && isPronounceable(piece.toLowerCase());
}

/**
 * Every run of letters of a slug word (`v1beta1` has `v` and `beta`) is short or pronounceable, within `max`.
 * Returns the number of 4+ letter runs, or -1 when a run is not a word.
 */
function slugWordRuns(word: string, max: number): number {
  let runs = 0;
  let start = -1;
  for (let i = 0; i <= word.length; i += 1) {
    const code = i < word.length ? word.charCodeAt(i) : 48;
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (letter && start < 0) {
      start = i;
    } else if (!letter && start >= 0) {
      const run = word.slice(start, i);
      if (run.length > PIECE_FREE_LETTERS) {
        if (!isWordPiece(run, max)) {
          return -1;
        }
        runs += 1;
      }
      start = -1;
    }
  }
  return runs;
}

/** Three or more plain words (`quick-start-guide-2`): a readable slug, never an id. */
function isSlugLike(segment: string): boolean {
  let words = 0;
  for (const word of segment.split(/[-_.]/)) {
    if (word === '') {
      continue;
    }
    // A number BETWEEN letters is only a version marker (`v1beta1`): `bc29wh` and `x9ayze6` are pieces of an id.
    if (
      !isSlugWord(word) ||
      (MID_DIGIT.test(word) && !VERSION_MARKER.test(word)) ||
      slugWordRuns(word, SLUG_LIKE_PIECE_MAX_LETTERS) < 0
    ) {
      return false;
    }
    words += 1;
  }
  return words >= 3;
}

/**
 * A camelCase / PascalCase identifier (`getUserDetailsV2`, `HTML5VideoPlayer2`, `Chapter12Section3`,
 * `gpt4oMiniPreview`): two or more Title-case words that can each be pronounced, with at most one fragment of 1-2
 * letters outside an acronym, three acronyms, three separate numbers of at most four digits. A string with one case
 * has no Title-case word and is never an identifier. Linear, no regex.
 */
function isCamelIdentifier(segment: string, inSlug = false): boolean {
  const kinds = (index: number): number => {
    const code = segment.charCodeAt(index);
    if (code >= 48 && code <= 57) {
      return 0;
    }
    if (code >= 65 && code <= 90) {
      return 1;
    }
    return code >= 97 && code <= 122 ? 2 : 3;
  };
  const length = segment.length;
  let titles = 0;
  let words = 0;
  let strong = 0; // words of 4+ letters: a 3-letter piece with a vowel is easy to hit by chance
  let strongLetters = 0;
  let covered = 0; // letters that belong to a pronounceable word or an acronym
  let strays = 0;
  let acronyms = 0;
  let digitRuns = 0;
  // An upper-case run counts as part of the name when it is a fragment (`V`, `FA`) or a known abbreviation: a random
  // `UPCG` is not evidence of anything.
  const acronym = (from: number, to: number): boolean => {
    const letters = to - from;
    if (letters <= STRAY_MAX_LETTERS || KNOWN_ACRONYMS.has(segment.slice(from, to).toLowerCase())) {
      covered += letters;
      strongLetters += letters >= CAMEL_STRONG_WORD_LETTERS ? letters : 0;
    }
    acronyms += 1;
    return acronyms <= CAMEL_MAX_ACRONYMS;
  };
  const word = (piece: string, isTitle: boolean): boolean => {
    if (piece.length <= STRAY_MAX_LETTERS) {
      strays += 1;
      return strays <= CAMEL_MAX_STRAY_PIECES;
    }
    titles += isTitle ? 1 : 0;
    words += 1;
    if (piece.length >= CAMEL_STRONG_WORD_LETTERS) {
      strong += 1;
      strongLetters += piece.length;
    }
    covered += piece.length;
    return isWordPiece(piece, CAMEL_PIECE_MAX_LETTERS);
  };
  let i = 0;
  while (i < length) {
    const kind = kinds(i);
    let j = i + 1;
    if (kind === 3) {
      return false;
    }
    if (kind === 0) {
      while (j < length && kinds(j) === 0) {
        j += 1;
      }
      digitRuns += 1;
      if (j - i > CAMEL_MAX_DIGITS || digitRuns > CAMEL_MAX_DIGIT_RUNS) {
        return false;
      }
    } else if (kind === 1) {
      while (j < length && kinds(j) === 1) {
        j += 1;
      }
      if (j < length && kinds(j) === 2) {
        // `HTMLVideo`: the last capital begins the Title word, the capitals before it are an acronym.
        const start = j - 1;
        let end = j;
        while (end < length && kinds(end) === 2) {
          end += 1;
        }
        if (start > i && !acronym(i, start)) {
          return false;
        }
        if (!word(segment.slice(start, end), true)) {
          return false;
        }
        j = end;
      } else {
        if (!acronym(i, j)) {
          return false;
        }
      }
    } else {
      while (j < length && kinds(j) === 2) {
        j += 1;
      }
      if (!word(segment.slice(i, j), false)) {
        return false;
      }
    }
    i = j;
  }
  // A name has a lead word and Title words after it (`paymentList`) only inside a slug, where the rest of the slug
  // vouches for it; on its own it needs two Title words, so a random `AbcDef` is not a name.
  const enough = inSlug ? titles >= 1 && words >= 2 : titles >= CAMEL_MIN_TITLE_WORDS;
  return (
    enough &&
    strong >= CAMEL_MIN_STRONG_WORDS &&
    strongLetters * 100 >= length * CAMEL_MIN_STRONG_COVERAGE_PERCENT &&
    covered * 100 >= length * CAMEL_MIN_COVERAGE_PERCENT
  );
}

/**
 * A separator-delimited slug in which words outnumber the numbers: a word is a camelCase
 * identifier or 3-12 letters (one case, or Title) that can be pronounced, with up to four trailing digits (`guide2`);
 * a number is up to four digits or a short code (`2024`, `v2`, `q3`, `h264`, `2fa`). A piece that mixes letters and
 * digits any other way (`k3j4`, `ab3de`) is what a random id is made of.
 */
function isWordSlug(segment: string): boolean {
  let words = 0;
  let numbers = 0;
  for (const piece of segment.split(/[-_.]/)) {
    if (piece === '') {
      continue;
    }
    const letters = SLUG_WORD_PIECE.exec(piece)?.[1];
    const lower = letters?.toLowerCase() ?? '';
    if (ALL_DIGITS.test(piece) ? piece.length <= CAMEL_MAX_DIGITS : SLUG_CODE_PIECE.test(piece)) {
      numbers += 1;
    } else if (
      letters !== undefined &&
      (letters === lower ||
        letters === letters.toUpperCase() ||
        letters === letters.charAt(0) + lower.slice(1))
    ) {
      if (!isPronounceable(lower)) {
        return false;
      }
      words += 1;
    } else if (isCamelIdentifier(piece, true)) {
      words += 1;
    } else {
      return false;
    }
  }
  return words >= 1 && words >= numbers;
}

/**
 * Whether a segment READS as an identifier made of words rather than a random token. Never true for a
 * single-case string without a separator: `clh3am4pu0000qfw9rg5d1zk` is as long and as lower-case as any English
 * run-on, and keeping it verbatim leaks an id (measured: a lower-case coverage rule kept 8-30% of cuid2 / base32 /
 * base36 ids). Privacy over grouping: what cannot be shown to be words is templated.
 */
function looksLikeWords(segment: string): boolean {
  return /[-_.]/.test(segment) ? isWordSlug(segment) : isCamelIdentifier(segment);
}

/** A phone number: optional leading `+`, then 7 to 15 numbers with `()-. ` separators. Linear, no regex. */
function looksLikePhone(segment: string): boolean {
  let count = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      count += 1;
      if (count > PHONE_MAX_LENGTH) {
        return false;
      }
      continue;
    }
    // `+` only as the first character; the usual separators anywhere.
    if (!(code === 43 ? i === 0 : ' ()-.'.includes(segment.charAt(i)))) {
      return false;
    }
  }
  return count >= PHONE_MIN_LENGTH;
}

/** A card number: 13-19 digits with only `-` / ` ` separators (no `+`, brackets or dots). Linear, no regex. */
function looksLikeCard(segment: string): boolean {
  let count = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      count += 1;
      if (count > CARD_MAX_LENGTH) {
        return false;
      }
    } else if (code !== 45 && code !== 32) {
      return false;
    }
  }
  return count >= CARD_MIN_LENGTH;
}

/** The number of separate runs of digits in a segment: `k3j4` has two, `2015` has one. Linear. */
function digitRuns(segment: string): number {
  let runs = 0;
  let inRun = false;
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    if (isDigit && !inRun) {
      runs += 1;
    }
    inRun = isDigit;
  }
  return runs;
}

/** Whether any run of 3+ letters (case-folded) between digits / separators cannot be pronounced: random letters, not a word. Linear. */
function hasUnpronounceableRun(segment: string): boolean {
  let start = -1;
  for (let i = 0; i <= segment.length; i += 1) {
    const code = i === segment.length ? 0 : segment.charCodeAt(i) | 32;
    if (code >= 97 && code <= 122) {
      start = start < 0 ? i : start;
    } else if (start >= 0) {
      if (i - start >= 3 && !isPronounceable(segment.slice(start, i).toLowerCase())) {
        return true;
      }
      start = -1;
    }
  }
  return false;
}

function looksLikeIp(segment: string): boolean {
  if (IPV4.test(segment)) {
    return true;
  }
  // IPv6: hex groups, with `::` compression or all eight groups. (A bare `10:20:30` is a time, not an IP.)
  return IPV6_CHARS.test(segment) && (segment.includes('::') || segment.split(':').length === 8);
}

/** One path segment, templated when it looks like an identifier or a secret; otherwise unchanged. */
export function templatePathSegment(segment: string): string {
  if (segment === '') {
    return segment;
  }
  if (segment.length > MAX_SEGMENT_LENGTH) {
    return '{token}';
  }
  // `%40` is how an e-mail address is usually encoded into a path; a phone number's space is `%20`.
  // Decoded twice: `%2540` is an `@` that was encoded again by a proxy or a framework router.
  const decoded = segment.includes('%') ? safeDecode(safeDecode(segment)) : segment;
  if (looksLikeEmail(segment) || looksLikeEmail(decoded)) {
    return '{email}';
  }
  if (ALL_DIGITS.test(segment)) {
    return '{id}';
  }
  if (UUID.test(segment)) {
    return '{uuid}';
  }
  if (LONG_HEX.test(segment)) {
    return '{hex}';
  }
  if (ISO_DATE.test(decoded)) {
    return '{date}';
  }
  if (looksLikeIp(segment) || looksLikeIpWithPort(segment)) {
    return '{ip}';
  }
  if (looksLikeCard(decoded)) {
    return '{card}';
  }
  if (looksLikePhone(decoded)) {
    return '{phone}';
  }
  if (TEL_PREFIX.test(decoded) && looksLikePhone(decoded.slice(4))) {
    return 'tel:{phone}';
  }
  // `42.json`, `<uuid>.png`: template the stem and keep the extension, so the file type still groups.
  const dot = segment.lastIndexOf('.');
  if (dot > 0 && FILE_EXTENSION.test(segment.slice(dot))) {
    const hashed = templateHashedPieces(segment.slice(0, dot));
    if (hashed !== segment.slice(0, dot)) {
      return `${hashed}${segment.slice(dot)}`;
    }
    const stem = templatePathSegment(segment.slice(0, dot));
    if (stem !== segment.slice(0, dot)) {
      return `${stem}${segment.slice(dot)}`;
    }
  }
  // `ord_12345`: keep the one-word prefix, template the number.
  const sep = Math.max(segment.lastIndexOf('_'), segment.lastIndexOf('-'));
  if (sep > 0) {
    const tail = segment.slice(sep + 1);
    if (
      tail.length >= PREFIXED_ID_MIN_LENGTH &&
      ALL_DIGITS.test(tail) &&
      PREFIX_HEAD.test(segment.slice(0, sep))
    ) {
      return `${segment.slice(0, sep + 1)}{id}`;
    }
  }
  if (TOKENISH.test(segment) && !isSlugLike(segment) && !looksLikeWords(segment)) {
    return '{token}';
  }
  if (
    SHORT_ID.test(segment) &&
    HAS_NUMBER.test(segment) &&
    HAS_UPPER.test(segment) &&
    HAS_LOWER.test(segment) &&
    !isSlugLike(segment) &&
    !looksLikeWords(segment)
  ) {
    return '{id}';
  }
  // A random token of 16-23 characters (base64url of a 12-17 byte value): mixed case with a number, or several
  // separate number runs. Ordinary words, `authentication-v2` and a lone year (`ecmascript2015modules`) are not.
  if (
    segment.length >= SHORT_TOKEN_MIN_LENGTH &&
    segment.length <= SHORT_TOKEN_MAX_LENGTH &&
    SHORT_TOKEN_CHARS.test(segment) &&
    HAS_NUMBER.test(segment) &&
    !isSlugLike(segment) &&
    !looksLikeWords(segment) &&
    ((HAS_UPPER.test(segment) && HAS_LOWER.test(segment)) ||
      digitRuns(segment) >= 2 ||
      (!/[-_.]/.test(segment) && hasUnpronounceableRun(segment)))
  ) {
    return '{token}';
  }
  return segment;
}

/** `scheme://host/path` with credentials, query and fragment removed and identifier segments templated. */
export function sanitizeDetectorUrl(raw: string): string {
  if (raw === '') {
    return '';
  }
  const noQuery = raw.split(/[?#]/)[0] ?? '';
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/]*@)?([^/]*)(.*)$/i.exec(noQuery);
  const prefix = authority === null ? '' : `${authority[1]}${authority[2]}`;
  const path = authority === null ? noQuery : (authority[3] ?? '');
  return prefix + path.split('/').map(templatePathSegment).join('/');
}
