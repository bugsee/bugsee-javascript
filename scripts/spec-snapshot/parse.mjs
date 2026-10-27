// Parses the JavaScript platform spec (bugsee/specs `sdk/reporting/platforms/javascript.md`) into the machine-readable
// snapshot vendored at `packages/protocol/spec/javascript-system-traces.snapshot.json`.
//
// Pure (markdown string in, plain object out) so it is unit-tested against fixtures and mutated like any other code.
// Only the TABLES the contract is written in are read; prose is ignored. A table is recognised by the nearest `##`/`###`
// heading above it (see SECTIONS), so a renamed heading fails loudly (`parseSpec` throws) instead of silently dropping names.

/** The inventory sections: heading text -> what the rows in it are. */
export const SECTIONS = {
  'Traces shared with mobile': { kind: 'trace', family: 'shared' },
  'Browser family traces': { kind: 'trace', family: 'browser' },
  'Node family traces': { kind: 'trace', family: 'node' },
  'Electron main traces': { kind: 'trace', family: 'electron-main' },
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

const plain = (text) => text.replace(/\*\*/g, '').replace(/`/g, '');

/** Value type and unit from a trace's `value` cell, e.g. `int bytes (...)`, `float, **percent 0-100** ...`. */
export function describeValue(cell) {
  const text = plain(cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
  const type = /^(int|float|string|object|list)\b/.exec(text)?.[1] ?? null;
  const clause = text.split(/ — | \(|:/)[0]; // the part before the first explanation
  let unit = null;
  if (/\bbytes\b/.test(clause)) unit = 'bytes';
  else if (/binary MB/.test(clause)) unit = 'mb';
  else if (/microseconds/.test(clause)) unit = 'us';
  else if (/\bpercent\b/.test(clause)) unit = 'percent';
  else if (/frames per second/.test(clause)) unit = 'fps';
  else if (/\bseconds\b/.test(clause)) unit = 's';
  else if (/\bms\b/.test(clause)) unit = 'ms';
  return { valueType: type, unit };
}

/** Param keys from an event's `params` cell: backticked camelCase tokens, `?` marks optional. */
export function paramKeysOf(cell) {
  const text = cell.replace(/\[[^\]]*\]\([^)]*\)/g, ''); // links are cross-references, never keys
  if (/^none\b/.test(text)) return [];
  const keys = [];
  for (const segment of text.split(';')) {
    const head = segment.split('∈')[0];
    for (const token of backticked(head)) {
      if (/^[a-z][A-Za-z]*\??$/.test(token) && !keys.includes(token)) keys.push(token);
    }
  }
  return keys;
}

/**
 * One params list per event name: the union over the families that list it (`process_exiting` has `persisted` in the
 * browser and `code` in Node). A key optional in ANY family (`foo?`) is optional in the union, so `foo` and `foo?` never
 * appear as two keys. Sorted, for a stable snapshot.
 */
export function mergeParams(a, b) {
  const optional = new Map();
  for (const key of [...a, ...b]) {
    const bare = key.replace(/\?$/, '');
    optional.set(bare, optional.get(bare) === true || key.endsWith('?'));
  }
  return [...optional].map(([bare, opt]) => (opt ? `${bare}?` : bare)).sort();
}

/** Everything the markdown declares, or throws when an expected section is missing. */
export function parseSpec(markdown) {
  const traces = new Map();
  const events = new Map();
  const retired = [];
  const notEmitted = [];
  const seenSections = new Set();
  let heading = '';
  let header = null;
  let inTable = false;

  for (const line of markdown.split('\n')) {
    const h = /^#{2,3} (.+)$/.exec(line);
    if (h) {
      heading = h[1].trim();
      header = null;
      inTable = false;
      continue;
    }
    if (!line.startsWith('|')) {
      inTable = false;
      header = null;
      continue;
    }
    const cells = splitRow(line);
    if (!inTable) {
      inTable = true;
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    const section = SECTIONS[heading];
    const column = (name) => {
      const i = header.indexOf(name);
      return i === -1 ? undefined : cells[i];
    };
    if (heading === RETIRED_HEADING) {
      seenSections.add(heading);
      retired.push(...namesIn(cells[0]));
    } else if (heading === NOT_EMITTED_HEADING) {
      seenSections.add(heading);
      notEmitted.push(...backticked(cells[0]));
    } else if (section) {
      seenSections.add(heading);
      const names = namesIn(cells[0]);
      const rowText = cells.join(' | ');
      const pending = [...new Set([...rowText.matchAll(/\[pending: (C\d+)/g)].map((m) => m[1]))];
      const target = section.kind === 'trace' ? traces : events;
      for (const name of names) {
        const entry = target.get(name) ?? { name, families: [], pending: [] };
        if (!entry.families.includes(section.family)) entry.families.push(section.family);
        for (const id of pending) if (!entry.pending.includes(id)) entry.pending.push(id);
        if (section.kind === 'trace') {
          const value = column('value') ?? '';
          const described = describeValue(value);
          entry.valueType ??= described.valueType;
          entry.unit ??= described.unit;
          const held = column('held');
          entry.held ??= held === undefined ? false : held.startsWith('held');
        } else {
          entry.params = mergeParams(entry.params ?? [], paramKeysOf(column('params') ?? ''));
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
