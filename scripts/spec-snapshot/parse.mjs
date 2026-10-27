// Parses the JavaScript platform spec (bugsee/specs `sdk/reporting/platforms/javascript.md`) into the machine-readable
// snapshot vendored at `packages/protocol/spec/javascript-system-traces.snapshot.json`.
//
// Pure (markdown string in, plain object out) so it is unit-tested against fixtures and mutated like any other code.
// Only the TABLES the contract is written in are read; prose is ignored. A table is recognised by the nearest `##`/`###`
// heading above it (see SECTIONS), so a renamed heading fails loudly (`parseSpec` throws) instead of silently dropping names.

/**
 * The inventory sections: heading text -> what the rows in it are, and the columns the table MUST have (a renamed or
 * dropped column must fail the parse, never silently read as "no value" / "not held").
 */
export const SECTIONS = {
  'Traces shared with mobile': { kind: 'trace', family: 'shared', held: true },
  'Browser family traces': { kind: 'trace', family: 'browser', held: true },
  // the Node table has no held column: "all rows are sampled on the 1 s tick and not held unless stated"
  'Node family traces': { kind: 'trace', family: 'node', held: false },
  'Electron main traces': { kind: 'trace', family: 'electron-main', held: true },
  'Events shared with mobile': { kind: 'event', family: 'shared' },
  'Browser family events': { kind: 'event', family: 'browser' },
  'Node family events': { kind: 'event', family: 'node' },
  'Electron main events': { kind: 'event', family: 'electron-main' },
};
const RETIRED_HEADING = 'Retired names';
const NOT_EMITTED_HEADING = 'Mobile traces and events the JavaScript SDK does not emit';

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Splits one markdown table row on unescaped pipes. */
export function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.slice(1, -1).map((c) => c.trim()); // drop the empty cells outside the outer pipes
}

const backticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** The wire names a first cell declares: every backticked token that is a plain identifier. */
export function namesIn(cell) {
  return backticked(cell).filter((t) => IDENT.test(t));
}

/**
 * The names of an inventory row's first cell. EVERY backticked token there must be a plain identifier: a wildcard
 * (`v8_heap_*`) or a shorthand would otherwise be dropped without a trace, and so would the names it stands for.
 */
export function strictNamesIn(cell) {
  const tokens = backticked(cell);
  const bad = tokens.filter((t) => !IDENT.test(t));
  if (bad.length > 0) throw new Error(`not a plain wire name in the first cell: ${bad.join(', ')}`);
  if (tokens.length === 0) throw new Error(`no backticked wire name in the first cell: ${cell}`);
  return tokens;
}

const plain = (text) => text.replace(/\*\*/g, '').replace(/`/g, '');

/** Unit words a value cell may use, by the unit code they stand for. Order matters: the first match wins. */
const UNITS = [
  ['bytes', /\bbytes\b/],
  ['mb', /\bbinary MB\b/],
  ['us', /\bmicroseconds\b/],
  ['percent', /\bpercent\b/],
  ['fps', /\bframes per second\b/],
  ['s', /\bseconds\b/],
  ['ms', /\bms\b/],
];
/** Words that name a unit this tool does not map: seeing one means the spec moved, so the parse fails. */
const UNKNOWN_UNIT =
  /\b(milliseconds?|nanoseconds?|minutes?|hours?|[KMGT]i?B|kilobytes?|megabytes?|gigabytes?|kbps|mbps|hz)\b|%/i;

/** Value type and unit from a trace's `value` cell, e.g. `int bytes (...)`, `float, **percent 0-100** ...`. */
export function describeValue(cell) {
  const text = plain(cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
  const type = /^(int|float|string|object|list)\b/.exec(text)?.[1] ?? null;
  const clause = text.split(/ — | \(|:/)[0]; // the part before the first explanation
  const known = UNITS.find(([, re]) => re.test(clause));
  if (known === undefined) {
    // "binary MB" is the one mapped spelling of MB; any other unit word is unknown
    const unknown = UNKNOWN_UNIT.exec(clause);
    if (unknown !== null) throw new Error(`unknown unit word "${unknown[0]}" in: ${cell}`);
  }
  return { valueType: type, unit: known?.[0] ?? null };
}

/**
 * Param keys from an event's `params` cell: backticked camelCase tokens, `?` marks a key that may be absent. A key is
 * optional when its token ends in `?`, when the text right after it says it is omitted, or for every key when the cell
 * says the event can carry no params at all.
 */
export function paramKeysOf(cell) {
  const text = cell.replace(/\[[^\]]*\]\([^)]*\)/g, ''); // links are cross-references, never keys
  if (/^none\b/.test(text)) return [];
  const noParamsAtAll = /no params at all/.test(text);
  const keys = new Map();
  for (const segment of text.split(';')) {
    const head = segment.split('∈')[0];
    const tokens = [...head.matchAll(/`([^`]+)`/g)];
    tokens.forEach((m, i) => {
      const token = m[1];
      if (!/^[a-z][A-Za-z]*\??$/.test(token)) return;
      const after = head.slice(m.index + m[0].length, tokens[i + 1]?.index ?? head.length);
      const bare = token.replace(/\?$/, '');
      const optional = noParamsAtAll || token.endsWith('?') || /\bomitted\b/.test(after);
      keys.set(bare, keys.get(bare) === true || optional);
    });
  }
  return [...keys].map(([bare, optional]) => (optional ? `${bare}?` : bare));
}

/**
 * One params list per event name across the families that list it (`process_exiting` has `persisted` in the browser and
 * `code` in Node). A key is optional when ANY side marks it optional or when a side does not list it at all: no single
 * runtime sends both. Sorted, for a stable snapshot.
 */
export function mergeParams(a, b) {
  const bare = (key) => key.replace(/\?$/, '');
  const aBare = new Set(a.map(bare));
  const bBare = new Set(b.map(bare));
  const optional = new Map();
  for (const key of [...a, ...b]) {
    const name = bare(key);
    const missingSomewhere = !(aBare.has(name) && bBare.has(name));
    optional.set(name, optional.get(name) === true || key.endsWith('?') || missingSomewhere);
  }
  return [...optional].map(([name, opt]) => (opt ? `${name}?` : name)).sort();
}

/** A row's keys: the earlier row's (for "the same keys, plus ..."), then its own; a repeated key keeps its optionality. */
function mergeRow(base, own) {
  const out = new Map();
  for (const key of [...base, ...own]) {
    const name = key.replace(/\?$/, '');
    out.set(name, out.get(name) === true || key.endsWith('?'));
  }
  return [...out].map(([name, opt]) => (opt ? `${name}?` : name));
}

/** Everything the markdown declares, or throws when an expected section is missing or a row cannot be read. */
export function parseSpec(markdown) {
  const traces = new Map();
  const events = new Map();
  const retired = [];
  const notEmitted = [];
  const seenSections = new Set();
  let heading = '';
  let header = null;
  let inTable = false;
  let lastKeys = null; // the previous event row's keys in this table ("the same keys, plus ...")

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim(); // an indented table is still a table
    const h = /^#{2,3} (.+)$/.exec(line);
    if (h) {
      heading = h[1].trim();
      header = null;
      inTable = false;
      lastKeys = null;
      continue;
    }
    if (!line.startsWith('|')) {
      inTable = false;
      header = null;
      lastKeys = null;
      continue;
    }
    const cells = splitRow(line);
    if (!inTable) {
      inTable = true;
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.length !== header.length) {
      // typically an unescaped pipe inside a code span: the row would be read against the wrong columns
      throw new Error(
        `row has ${cells.length} cells, header has ${header.length} (${heading}): ${line}`,
      );
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // the separator row
    const section = SECTIONS[heading];
    const column = (name) => {
      const i = header.indexOf(name);
      return i === -1 ? undefined : cells[i];
    };
    if (heading === RETIRED_HEADING) {
      seenSections.add(heading);
      const names = namesIn(cells[0]);
      if (names.length === 0) throw new Error(`retired row names nothing: ${line}`);
      retired.push(...names);
    } else if (heading === NOT_EMITTED_HEADING) {
      seenSections.add(heading);
      const tokens = backticked(cells[0]);
      if (tokens.length === 0) throw new Error(`mobile-only row names nothing: ${line}`);
      notEmitted.push(...tokens);
    } else if (section) {
      seenSections.add(heading);
      const names = strictNamesIn(cells[0]);
      const need =
        section.kind === 'trace' ? ['value', ...(section.held ? ['held'] : [])] : ['params'];
      for (const col of need) {
        if (!header.includes(col)) throw new Error(`table "${heading}" has no "${col}" column`);
      }
      const rowText = cells.join(' | ');
      const pending = [...new Set([...rowText.matchAll(/\[pending: (C\d+)/g)].map((m) => m[1]))];
      const target = section.kind === 'trace' ? traces : events;
      let rowKeys = null;
      if (section.kind === 'event') {
        const cell = column('params');
        const same = /^the same keys\b/i.test(cell);
        if (same && lastKeys === null)
          throw new Error(`"the same keys" with no earlier row: ${line}`);
        rowKeys = mergeRow(same ? lastKeys : [], paramKeysOf(cell));
        lastKeys = rowKeys;
      }
      for (const name of names) {
        const entry = target.get(name) ?? { name, families: [], pending: [] };
        if (!entry.families.includes(section.family)) entry.families.push(section.family);
        for (const id of pending) if (!entry.pending.includes(id)) entry.pending.push(id);
        if (section.kind === 'trace') {
          let described;
          try {
            described = describeValue(column('value'));
          } catch (error) {
            throw new Error(`${name}: ${error.message}`);
          }
          if (described.valueType === null)
            throw new Error(`${name}: value has no type: ${column('value')}`);
          let held = false;
          if (section.held) {
            const cell = column('held');
            if (cell !== 'held' && cell !== 'no')
              throw new Error(`${name}: held cell is "${cell}", not "held" or "no"`);
            held = cell === 'held';
          }
          for (const [field, now] of [
            ['valueType', described.valueType],
            ['unit', described.unit],
            ['held', held],
          ]) {
            if (field in entry && entry[field] !== now) {
              throw new Error(`${name}: families disagree on ${field} (${entry[field]} vs ${now})`);
            }
            entry[field] = now;
          }
        } else {
          entry.params =
            entry.params === undefined ? [...rowKeys].sort() : mergeParams(entry.params, rowKeys);
        }
        target.set(name, entry);
      }
    }
  }
  const missing = [...Object.keys(SECTIONS), RETIRED_HEADING, NOT_EMITTED_HEADING].filter(
    (s) => !seenSections.has(s),
  );
  if (missing.length > 0)
    throw new Error(`spec sections not found or empty: ${missing.join('; ')}`);
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    traces: [...traces.values()].sort(byName),
    events: [...events.values()].sort(byName),
    retired: [...new Set(retired)].sort(),
    notEmitted: [...new Set(notEmitted)].sort(),
  };
}
