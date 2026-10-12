// Seeded corpora for the URL sanitizer's acceptance numbers. Not a test file and not shipped (excluded from
// coverage and from the package entry): the unit test imports it, and the 200k scratch measurement imports it too, so
// the figures reported for it are produced by exactly the code the test runs.

/** mulberry32: a deterministic PRNG so every figure is reproducible, not luck. */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';

export interface TokenAlphabet {
  readonly name: string;
  /** Characters a token is drawn from (the first character may come from `first`). */
  readonly chars: string;
  readonly first?: string;
}

export const TOKEN_ALPHABETS: readonly TokenAlphabet[] = [
  { name: 'base64url', chars: `${UPPER}${LOWER}${DIGITS}-_` },
  { name: 'base62', chars: `${UPPER}${LOWER}${DIGITS}` },
  { name: 'hex', chars: '0123456789abcdef' },
  { name: 'base36-lower', chars: `${DIGITS}${LOWER}` },
  { name: 'base36-upper', chars: `${DIGITS}${UPPER}` },
  { name: 'base32-lower', chars: `${LOWER}234567` },
  // cuid2: a leading letter, then lower-case base36.
  { name: 'cuid2', chars: `${DIGITS}${LOWER}`, first: LOWER },
  // ULID, lower-cased: Crockford base32 (no i, l, o, u).
  { name: 'ulid-lower', chars: '0123456789abcdefghjkmnpqrstvwxyz' },
  // nanoid's default alphabet, lower-cased (custom alphabets are common for URL-safe, case-insensitive ids).
  { name: 'nanoid-lower', chars: `${DIGITS}${LOWER}_-` },
];

export interface LengthBucket {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

export const LENGTH_BUCKETS: readonly LengthBucket[] = [
  { name: '16-19', min: 16, max: 19 },
  { name: '20-21', min: 20, max: 21 },
  { name: '22-23', min: 22, max: 23 },
  { name: '24-31', min: 24, max: 31 },
  { name: '32-47', min: 32, max: 47 },
  { name: '48-64', min: 48, max: 64 },
];

/** `count` random tokens of `alphabet`, each of a length drawn uniformly from the bucket. */
export function randomTokens(
  alphabet: TokenAlphabet,
  bucket: LengthBucket,
  count: number,
  next: () => number,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = bucket.min + Math.floor(next() * (bucket.max - bucket.min + 1));
    let token =
      alphabet.first === undefined
        ? ''
        : alphabet.first.charAt(Math.floor(next() * alphabet.first.length));
    while (token.length < length) {
      token += alphabet.chars.charAt(Math.floor(next() * alphabet.chars.length));
    }
    out.push(token);
  }
  return out;
}

const VERBS = [
  'get',
  'list',
  'create',
  'update',
  'delete',
  'fetch',
  'load',
  'export',
  'import',
  'search',
  'validate',
  'reset',
  'send',
  'resend',
  'refresh',
  'sync',
  'upload',
  'download',
  'approve',
  'cancel',
  'archive',
  'restore',
  'merge',
  'publish',
  'subscribe',
  'verify',
  'submit',
  'review',
  'assign',
  'schedule',
  'render',
  'resolve',
];
const NOUNS = [
  'user',
  'account',
  'profile',
  'order',
  'invoice',
  'payment',
  'product',
  'cart',
  'item',
  'address',
  'session',
  'notification',
  'setting',
  'report',
  'dashboard',
  'project',
  'workspace',
  'comment',
  'message',
  'team',
  'member',
  'role',
  'permission',
  'subscription',
  'plan',
  'coupon',
  'shipment',
  'ticket',
  'customer',
  'catalog',
  'booking',
  'document',
  'template',
  'webhook',
  'invite',
  'channel',
  'review',
  'refund',
  'balance',
  'quota',
];
const MODIFIERS = [
  'details',
  'list',
  'summary',
  'history',
  'status',
  'preferences',
  'count',
  'stats',
  'overview',
  'settings',
  'options',
  'metadata',
  'timeline',
  'activity',
  'export',
  'search',
  'results',
  'threads',
  'groups',
  'rules',
];
const COLORS = ['BLACK', 'WHITE', 'NAVY', 'RED', 'GREEN', 'GREY', 'BLUE', 'OLIVE', 'SAND', 'PINK'];
const SIZES = ['XS', 'SM', 'MD', 'LG', 'XL', 'XXL', 'OS'];
const GOODS = [
  'TSHIRT',
  'HOODIE',
  'JACKET',
  'SNEAKER',
  'BACKPACK',
  'WALLET',
  'BOTTLE',
  'MUG',
  'CAP',
  'SCARF',
];
const LANGS = ['en', 'de', 'fr', 'es', 'pt', 'ja', 'ko', 'zh', 'it', 'nl', 'sv', 'pl', 'tr'];
const REGIONS = ['US', 'GB', 'DE', 'FR', 'BR', 'JP', 'KR', 'CN', 'TW', 'CA', 'AU', 'MX'];
const EXTENSIONS = ['js', 'css', 'png', 'svg', 'json', 'pdf', 'woff2', 'map', 'html', 'csv'];
const SUFFIXES = ['', '', 'V2', 'V3', '2', 'Query', 'Mutation', 'Async', 'ById', 'ForUser'];
const FAMILIES = [
  'camelCase handler',
  'PascalCase handler',
  'kebab slug',
  'snake slug',
  'version tag',
  'i18n tag',
  'file name',
  'SKU',
  'GraphQL operation',
];

function title(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export interface RouteSegment {
  readonly family: string;
  readonly segment: string;
}

/**
 * `count` realistic route segments of 16+ characters (shorter ones cannot be templated by the word-sensitive
 * rules, so including them would only flatter the figure). Every one is a human-meant name, so every templating is a
 * false positive.
 */
export function routeCorpus(count: number, seed = 0x5eed): RouteSegment[] {
  const next = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const out: RouteSegment[] = [];
  const make = (family: number): string => {
    const verb = pick(VERBS);
    const noun = pick(NOUNS);
    const modifier = pick(MODIFIERS);
    const noun2 = pick(NOUNS);
    switch (family) {
      case 0:
        return `${verb}${title(noun)}${title(modifier)}${pick(SUFFIXES)}`;
      case 1:
        return `${title(verb)}${title(noun)}${title(noun2)}${pick(['Controller', 'Handler', 'Service', 'Page', ''])}`;
      case 2: {
        const year =
          next() < 0.4
            ? `-${2018 + Math.floor(next() * 8)}`
            : next() < 0.3
              ? `-${1 + Math.floor(next() * 9)}`
              : '';
        return `${noun}-${modifier}-${verb}${year}${next() < 0.5 ? '-guide' : ''}`;
      }
      case 3:
        return `${noun}_${noun2}_${modifier}${next() < 0.5 ? `_${2019 + Math.floor(next() * 7)}_q${1 + Math.floor(next() * 4)}` : ''}`;
      case 4:
        return `${noun}-${modifier}-v${1 + Math.floor(next() * 4)}${next() < 0.5 ? `-${pick(['beta', 'rc', 'preview', 'final'])}${1 + Math.floor(next() * 3)}` : ''}`;
      case 5:
        return `${noun}-${modifier}-${pick(LANGS)}-${pick(REGIONS)}`;
      case 6: {
        const kind = Math.floor(next() * 3);
        if (kind === 0) {
          return `${noun}-${modifier}-${2019 + Math.floor(next() * 7)}-q${1 + Math.floor(next() * 4)}.${pick(EXTENSIONS)}`;
        }
        if (kind === 1) {
          return `${noun}${title(modifier)}.chunk.${pick(EXTENSIONS)}`;
        }
        return `${noun}-${modifier}-${noun2}.${pick(EXTENSIONS)}`;
      }
      case 7:
        return next() < 0.5
          ? `${pick(GOODS)}-${pick(COLORS)}-${pick(SIZES)}-${pick(COLORS)}`
          : `${pick(GOODS)}-${pick(['X', 'M', 'S'])}${100 + Math.floor(next() * 800)}-${pick(COLORS)}`;
      default:
        return `${title(verb)}${title(noun)}${title(modifier)}${pick(['Query', 'Mutation', 'Subscription', 'Fragment'])}`;
    }
  };
  let i = 0;
  while (out.length < count) {
    const family = i % FAMILIES.length;
    i += 1;
    const segment = make(family);
    if (segment.length >= 16) {
      out.push({ family: FAMILIES[family] as string, segment });
    }
  }
  return out;
}
