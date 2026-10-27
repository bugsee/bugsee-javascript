import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script (the refresh tool), no declaration file
import * as parser from '../../../scripts/spec-snapshot/parse.mjs';

// The parser that turns the JavaScript platform spec's tables into the vendored snapshot. Fixtures use the spec's own
// table shapes (including escaped pipes, multi-name cells, links in cells and pending markers).

const { parseSpec, splitRow, namesIn, describeValue, paramKeysOf, mergeParams, SECTIONS } =
  parser as {
    parseSpec(md: string): Parsed;
    splitRow(line: string): string[];
    namesIn(cell: string): string[];
    describeValue(cell: string): { valueType: string | null; unit: string | null };
    paramKeysOf(cell: string): string[];
    mergeParams(a: string[], b: string[]): string[];
    SECTIONS: Record<string, unknown>;
  };

interface Parsed {
  traces: Array<{
    name: string;
    families: string[];
    pending: string[];
    valueType: string | null;
    unit: string | null;
    held: boolean;
  }>;
  events: Array<{
    name: string;
    families: string[];
    params: string[];
    pending: string[];
  }>;
  retired: string[];
  notEmitted: string[];
}

const FIXTURE = `# Doc

## System trace inventory

### Traces shared with mobile

| trace | value | runtimes | held | mobile | notes |
|---|---|---|---|---|---|
| \`battery\` | int 0–100, percent | browser family | held | \`=\` | From the API. |
| \`fps\` | float, frames per second, one decimal | browser family | no | \`=\` | rAF |
| \`app_state\` | string \`foreground\` \\| \`background\` | browser family | held | \`=\` | PV |

### Browser family traces

| trace | value | held | source | notes |
|---|---|---|---|---|
| \`route\` | string — the router's pattern — [\`route\`](../bundle/traces.md#route) | held | adapters | **[pending: C12]** JS-specific |
| \`ram_js_heap_total\` | int bytes — the ceiling | no | perf | x |

### Node family traces

| trace | value | notes |
|---|---|---|
| \`process_memory_rss\`, \`process_memory_external\` | int bytes (\`memoryUsage()\`) | x |
| \`cpu_usage_user\` | int **microseconds** of CPU consumed (a delta), not percent | x |
| \`ram_js_heap_total\` | int bytes: \`heap_size_limit\` | **[pending: C22]** |

### Electron main traces

| trace | value | held | notes |
|---|---|---|---|
| \`app_metrics\` | object \`{processes:[…]}\` — [\`app_metrics\`](x.md) | no | x |

### Availability by runtime

| trace | browser | Node |
|---|---|---|
| \`battery\` | Y | — |

### Retired names

| retired | replaced by |
|---|---|
| \`screen_size\` \`{width, height, dpr}\` (browser) — retired | a one-entry displays |
| \`gc_count\`, \`gc_pause_ms\` | the gc event |

### Mobile traces and events the JavaScript SDK does not emit

| mobile name | platform | why not |
|---|---|---|
| \`wifi\`, \`cellular\` | both | no API |
| \`Activity*\`, \`LowMemory\` | both | concepts |

## System event inventory

### Events shared with mobile

| event | params | trigger | runtimes | mobile counterpart |
|---|---|---|---|---|
| \`OrientationChanged\` | \`current\` int (the [\`orientation\`](#t) value), \`prev\` int (omitted when unknown), \`type\` string, \`angle\` number — **together**; **no params at all** when the engine cannot read both | a change | browser family | x |
| \`DarkModeChanged\` | \`dark\` boolean (JS-specific extra) | mq | browser family | x |

### Browser family events

| event | params | trigger | notes |
|---|---|---|---|
| \`process_started\` | none | activating | |
| \`process_exiting\` | \`persisted\` boolean | pagehide | |
| \`display_mode_changed\` | \`mode\` ∈ \`fullscreen\`, \`standalone\`; \`previousMode\` same set (omitted if unreadable) | mq | |
| \`private_mode_detected\` | \`method?\` \`storage-quota\` | yes | |

### Node family events

| event | params | trigger | notes |
|---|---|---|---|
| \`process_started\` | none | activating | |
| \`process_exiting\` | \`code\` int | exit | |
| \`process_signal\` | \`signal\` string (default \`SIGTERM\`, \`SIGINT\`) | signal | |

### Electron main events

| event | params | trigger | requires |
|---|---|---|---|
| \`child_process_gone\` | \`type\`, \`exitCode?\`, \`serviceName?\` (Electron strings verbatim) | app | \`app\` |
| \`display_added\` | a [\`displays\`](x.md) entry in camelCase: \`id\`, \`nativeId\`, \`width?\` | screen | \`screen\` |
| \`display_metrics_changed\` | the same keys, plus \`changed\` string[] and \`width\` | screen | \`screen\` |
`;

const trace = (md: string, name: string) => parseSpec(md).traces.find((t) => t.name === name);
const event = (md: string, name: string) => parseSpec(md).events.find((t) => t.name === name);

describe('splitRow', () => {
  it('splits on unescaped pipes only and trims the cells outside the outer pipes', () => {
    expect(splitRow('| a | b \\| c | d |')).toEqual(['a', 'b | c', 'd']);
    expect(splitRow('|x|')).toEqual(['x']);
  });
});

describe('namesIn', () => {
  it('returns every backticked plain identifier and nothing else', () => {
    expect(namesIn('`a_b`, `C1` `{x, y}` `has-dash` `Star*` plain')).toEqual(['a_b', 'C1']);
  });
});

describe('describeValue', () => {
  it.each([
    ['int bytes (`x`)', 'int', 'bytes'],
    ['int binary MB', 'int', 'mb'],
    ['int **microseconds** of CPU, not percent', 'int', 'us'],
    ['float, **percent 0–100** of the window', 'float', 'percent'],
    ['float, frames per second, one decimal', 'float', 'fps'],
    ['int seconds until full', 'int', 's'],
    ['float ms — mean, max', 'float', 'ms'],
    ['string `a` \\| `b`', 'string', null],
    ['object `{state}` — [`capture`](x.md)', 'object', null],
    ['list of display objects', 'list', null],
    ['int 0–4: `0` unknown', 'int', null],
    ['something else', null, null],
    ['**int** bytes', 'int', 'bytes'],
    ['`float` ms', 'float', 'ms'],
  ])('reads %s', (cell, valueType, unit) => {
    expect(describeValue(cell)).toEqual({ valueType, unit });
  });

  it('rejects a percent sign and other unit symbols', () => {
    expect(() => describeValue('float 50%')).toThrow(/unknown unit word "%"/);
    expect(() => describeValue('string 50% of it')).toThrow(/unknown unit word "%"/);
  });

  it('takes the unit from the first clause only, never from the explanation after it', () => {
    expect(describeValue('int — measured in bytes later').unit).toBeNull();
    expect(describeValue('int (a delta of bytes)').unit).toBeNull();
    expect(describeValue('int: bytes').unit).toBeNull();
  });
});

describe('paramKeysOf', () => {
  it('is empty for none, keeps ? on optional keys and ignores links, enum members and upper-case words', () => {
    expect(paramKeysOf('none')).toEqual([]);
    expect(paramKeysOf('`method?` `storage-quota`')).toEqual(['method?']);
    expect(paramKeysOf('`mode` ∈ `fullscreen`, `standalone`; `previousMode` same set')).toEqual([
      'mode',
      'previousMode',
    ]);
    expect(paramKeysOf('`current` int (the [`orientation`](#t) value), `prev` int')).toEqual([
      'current',
      'prev',
    ]);
    expect(paramKeysOf('`signal` string (default `SIGTERM`, `SIGINT`)')).toEqual(['signal']);
    expect(paramKeysOf('`a`, `a`, `b`')).toEqual(['a', 'b']);
    expect(paramKeysOf('`a?`, `a`')).toEqual(['a?']); // optional once is optional
    expect(paramKeysOf('`a`, `a?`')).toEqual(['a?']);
    // "(omitted ...)" qualifies the key right before it, not the ones before that
    expect(paramKeysOf('`a` int, `b` int (omitted when x)')).toEqual(['a', 'b?']);
    expect(paramKeysOf('`a` int (omitted when x), `b` int')).toEqual(['a?', 'b']);
    expect(paramKeysOf('none (the `flag` is separate)')).toEqual([]);
    expect(paramKeysOf('`a`, none')).toEqual(['a']); // "none" only counts at the start
  });
});

describe('parseSpec fails closed (a spec edit must never be read as "nothing")', () => {
  const FP = '| `fps` | float, frames per second, one decimal | browser family | no | `=` | rAF |';
  const BATTERY =
    '| `battery` | int 0–100, percent | browser family | held | `=` | From the API. |';
  const mutate = (from: string, to: string): string => {
    expect(FIXTURE).toContain(from); // the probe edits something that is really there
    return FIXTURE.replace(from, to);
  };

  it('rejects a held cell that is not exactly held or no', () => {
    for (const bad of ['**held**', 'held (re-recorded)', 'Held', 'yes', '', 'not held', 'held,']) {
      expect(() => parseSpec(mutate(BATTERY, BATTERY.replace('| held |', `| ${bad} |`)))).toThrow(
        /held cell is/,
      );
    }
    expect(() => parseSpec(mutate(FP, FP.replace('| no |', '| no, |')))).toThrow(/held cell is/);
  });

  it('rejects a table whose value, held or params column was renamed or dropped', () => {
    expect(() =>
      parseSpec(
        mutate(
          '| trace | value | runtimes | held | mobile | notes |',
          '| trace | values | runtimes | held | mobile | notes |',
        ),
      ),
    ).toThrow(/no "value" column/);
    expect(() =>
      parseSpec(
        mutate(
          '| trace | value | runtimes | held | mobile | notes |',
          '| trace | value | runtimes | step | mobile | notes |',
        ),
      ),
    ).toThrow(/no "held" column/);
    expect(() =>
      parseSpec(
        mutate('| event | params | trigger | notes |', '| event | parameters | trigger | notes |'),
      ),
    ).toThrow(/no "params" column/);
  });

  it('does not require a held column in the Node table (it has none)', () => {
    expect(() => parseSpec(FIXTURE)).not.toThrow();
  });

  it('rejects a row whose first cell names nothing, or names something that is not a plain identifier', () => {
    expect(() => parseSpec(mutate(BATTERY, BATTERY.replace('`battery`', 'battery')))).toThrow(
      /no backticked wire name/,
    );
    expect(() => parseSpec(mutate(BATTERY, BATTERY.replace('`battery`', '`v8_heap_*`')))).toThrow(
      /not a plain wire name.*v8_heap_\*/,
    );
    expect(() =>
      parseSpec(mutate(BATTERY, BATTERY.replace('`battery`', '`battery` `{x}`'))),
    ).toThrow(/not a plain wire name/);
    expect(() =>
      parseSpec(
        mutate('| `gc_count`, `gc_pause_ms` | the gc event |', '| gc_count | the gc event |'),
      ),
    ).toThrow(/retired row names nothing/);
    expect(() =>
      parseSpec(mutate('| `wifi`, `cellular` | both | no API |', '| wifi | both | no API |')),
    ).toThrow(/mobile-only row names nothing/);
  });

  it('rejects a value with no type', () => {
    expect(() =>
      parseSpec(mutate(BATTERY, BATTERY.replace('int 0–100, percent', 'a number'))),
    ).toThrow(/battery: value has no type/);
  });

  it('rejects a unit word it does not know, naming the trace', () => {
    for (const unit of [
      'milliseconds',
      'Milliseconds',
      'MiB',
      'KB',
      'kB',
      'mib',
      'nanoseconds',
      'GB',
      'minutes',
      'kbps',
      'Hz',
    ]) {
      expect(() =>
        parseSpec(mutate(FP, FP.replace('float, frames per second, one decimal', `float ${unit}`))),
      ).toThrow(new RegExp(`fps: unknown unit word "${unit}"`));
    }
  });

  it('rejects a row with more or fewer cells than the header (an unescaped pipe in a code span)', () => {
    expect(() => parseSpec(mutate(FP, '| `fps` | float | a `x | y` | no | `=` | rAF |'))).toThrow(
      /row has 7 cells, header has 6/,
    );
    expect(() => parseSpec(mutate(FP, '| `fps` | float |'))).toThrow(/row has 2 cells/);
  });

  it('reads an indented table, a trailing-space row and a header-cased column', () => {
    const indented = FIXTURE.split('\n')
      .map((l) => (l.startsWith('|') ? `   ${l}  ` : l))
      .join('\n');
    expect(parseSpec(indented)).toEqual(parseSpec(FIXTURE));
  });

  it("rejects families that disagree on a trace's type, unit or held-ness", () => {
    expect(() =>
      parseSpec(
        mutate(
          '| `ram_js_heap_total` | int bytes: `heap_size_limit` | **[pending: C22]** |',
          '| `ram_js_heap_total` | float bytes | x |',
        ),
      ),
    ).toThrow(/families disagree on valueType/);
    expect(() =>
      parseSpec(
        mutate(
          '| `ram_js_heap_total` | int bytes: `heap_size_limit` | **[pending: C22]** |',
          '| `ram_js_heap_total` | int percent | x |',
        ),
      ),
    ).toThrow(/families disagree on unit/);
    expect(() =>
      parseSpec(
        mutate(
          '| `ram_js_heap_total` | int bytes — the ceiling | no | perf | x |',
          '| `ram_js_heap_total` | int bytes — the ceiling | held | perf | x |',
        ),
      ),
    ).toThrow(/families disagree on held/);
  });

  it('"the same keys" never reaches across a heading, even with no blank line between table and heading', () => {
    const lines = FIXTURE.split('\n').filter(
      (l) => !l.includes('`child_process_gone`') && !l.includes('`display_added`'),
    );
    const md = lines
      .join('\n')
      .replace('\n\n### Electron main events\n\n', '\n### Electron main events\n');
    expect(md).toContain('\n### Electron main events\n| event');
    expect(() => parseSpec(md)).toThrow(/"the same keys" with no earlier row/);
  });

  it('rejects "the same keys" with no earlier row to copy', () => {
    const lines = FIXTURE.split('\n').filter(
      (l) => !l.includes('`child_process_gone`') && !l.includes('`display_added`'),
    );
    expect(() => parseSpec(lines.join('\n'))).toThrow(/"the same keys" with no earlier row/);
  });
});

describe('parseSpec rejects spec changes it cannot read (a new table must never be ignored)', () => {
  const NODE_ROW =
    '| `cpu_usage_user` | int **microseconds** of CPU consumed (a delta), not percent | x |';

  it('throws on a table under an unrecognised ### heading inside an inventory section', () => {
    const worker = `\n### Worker family traces\n\n| trace | value | held | notes |\n|---|---|---|---|\n| \`worker_lag\` | float ms | no | x |\n`;
    expect(() =>
      parseSpec(FIXTURE.replace('### Retired names', `${worker}\n### Retired names`)),
    ).toThrow(/Worker family traces/);
    const evt = `\n### Worker family events\n\n| event | params | trigger | notes |\n|---|---|---|---|\n| \`w\` | none | x | |\n`;
    expect(() =>
      parseSpec(FIXTURE.replace('### Browser family events', `${evt}\n### Browser family events`)),
    ).toThrow(/Worker family events/);
  });

  it('allows the known non-inventory tables (Availability by runtime, Retired names) and tables outside the inventories', () => {
    expect(() => parseSpec(FIXTURE)).not.toThrow();
    expect(FIXTURE).toContain('### Availability by runtime');
    const options = `${FIXTURE}\n## Options\n\n### Gates\n\n| option | default |\n|---|---|\n| \`x\` | y |\n`;
    expect(() => parseSpec(options)).not.toThrow();
  });

  it('throws on a table placed directly under an inventory heading (no ### of its own)', () => {
    const md = FIXTURE.replace(
      '## System trace inventory\n',
      '## System trace inventory\n\n| a | b |\n|---|---|\n| `c` | d |\n',
    );
    expect(() => parseSpec(md)).toThrow(/System trace inventory/);
  });

  it('throws on a unit word in a numeric value with no known unit (int degrees)', () => {
    for (const bad of ['int degrees', 'float, radians', 'int meters (m)', 'float Celsius']) {
      expect(() => parseSpec(FIXTURE.replace('int 0–100, percent', bad))).toThrow(
        /unknown unit word/,
      );
    }
    // numbers, ranges and punctuation after the type are fine, and a string/object/list may be followed by a word
    for (const ok of [
      'int 0–4: `0` unknown',
      'int `0` nominal',
      'int',
      'float — the share',
      'int (a count)',
      'int, 0–10',
    ]) {
      expect(() => parseSpec(FIXTURE.replace('int 0–100, percent', ok))).not.toThrow();
    }
    expect(() => parseSpec(FIXTURE.replace('int 0–100, percent', 'string active'))).not.toThrow();
  });

  it('throws when a Node-table note states held-ness (the table has no held column to carry it)', () => {
    expect(FIXTURE).toContain(NODE_ROW);
    for (const note of [
      '**Held.** re-recorded',
      '**held** every 10 s',
      '**  Held**',
      'Not sampled. Held when stated',
    ]) {
      expect(() =>
        parseSpec(FIXTURE.replace(NODE_ROW, NODE_ROW.replace('| x |', `| ${note} |`))),
      ).toThrow(/states held-ness/);
    }
    // the word in ordinary prose is not a claim (the real spec says "does not stay held")
    expect(() =>
      parseSpec(
        FIXTURE.replace(NODE_ROW, NODE_ROW.replace('| x |', '| a lifted cap does not stay held |')),
      ),
    ).not.toThrow();
  });

  it('does not treat the held word in a table WITH a held column as a note', () => {
    expect(() => parseSpec(FIXTURE)).not.toThrow(); // the Browser/Shared rows carry "held" in the column
  });
});

describe('mergeParams', () => {
  it('unions and sorts; a key only one side lists is optional (no single runtime sends both)', () => {
    expect(mergeParams(['b', 'a'], ['c'])).toEqual(['a?', 'b?', 'c?']);
    expect(mergeParams([], [])).toEqual([]);
  });

  it('keeps a key both sides list as it is, and one key per name, optional when ANY side marks it optional', () => {
    expect(mergeParams(['foo'], ['foo'])).toEqual(['foo']);
    expect(mergeParams(['foo'], ['foo?'])).toEqual(['foo?']);
    expect(mergeParams(['foo?'], ['foo'])).toEqual(['foo?']);
    expect(mergeParams(['foo', 'bar?'], ['foo', 'bar'])).toEqual(['bar?', 'foo']);
    expect(mergeParams(['foo?'], ['foo?'])).toEqual(['foo?']);
  });

  it('is asymmetric-safe: a key in only the second list is optional too', () => {
    expect(mergeParams(['a'], ['a', 'b'])).toEqual(['a', 'b?']);
    expect(mergeParams(['a', 'b'], ['a'])).toEqual(['a', 'b?']);
  });
});

describe('parseSpec', () => {
  it('reads every inventory section', () => {
    const parsed = parseSpec(FIXTURE);
    expect(parsed.traces.map((t) => t.name)).toEqual([
      'app_metrics',
      'app_state',
      'battery',
      'cpu_usage_user',
      'fps',
      'process_memory_external',
      'process_memory_rss',
      'ram_js_heap_total',
      'route',
    ]);
    expect(parsed.events.map((e) => e.name)).toEqual([
      'DarkModeChanged',
      'OrientationChanged',
      'child_process_gone',
      'display_added',
      'display_metrics_changed',
      'display_mode_changed',
      'private_mode_detected',
      'process_exiting',
      'process_signal',
      'process_started',
    ]);
    expect(Object.keys(SECTIONS)).toHaveLength(8);
  });

  it('records family, value type, unit and held per trace', () => {
    expect(trace(FIXTURE, 'battery')).toEqual({
      name: 'battery',
      families: ['shared'],
      pending: [],
      valueType: 'int',
      unit: 'percent',
      held: true,
    });
    expect(trace(FIXTURE, 'fps')).toMatchObject({ held: false, unit: 'fps' });
    expect(trace(FIXTURE, 'app_state')).toMatchObject({
      valueType: 'string',
      unit: null,
      held: true,
    });
    expect(trace(FIXTURE, 'app_metrics')).toMatchObject({
      families: ['electron-main'],
      valueType: 'object',
      held: false,
    });
  });

  it('treats a table with no held column as not held, and a name in several tables as one entry', () => {
    expect(trace(FIXTURE, 'process_memory_rss')).toMatchObject({
      held: false,
      families: ['node'],
      unit: 'bytes',
    });
    expect(trace(FIXTURE, 'process_memory_external')).toMatchObject({ families: ['node'] });
    expect(trace(FIXTURE, 'ram_js_heap_total')).toMatchObject({
      families: ['browser', 'node'],
      pending: ['C22'],
      held: false,
    });
    expect(trace(FIXTURE, 'cpu_usage_user')).toMatchObject({ unit: 'us' });
  });

  it('records pending markers', () => {
    expect(trace(FIXTURE, 'route')).toMatchObject({
      pending: ['C12'],
      valueType: 'string',
      held: true,
    });
  });

  it('records event params per family and the union', () => {
    expect(event(FIXTURE, 'process_exiting')).toEqual({
      name: 'process_exiting',
      families: ['browser', 'node'],
      pending: [],
      params: ['code?', 'persisted?'],
    });
    expect(event(FIXTURE, 'process_started')).toMatchObject({ params: [] });
    expect(event(FIXTURE, 'OrientationChanged')).toMatchObject({
      params: ['angle?', 'current?', 'prev?', 'type?'], // "no params at all" when the engine cannot read both
    });
    expect(event(FIXTURE, 'display_mode_changed')).toMatchObject({
      params: ['mode', 'previousMode?'],
    });
    expect(event(FIXTURE, 'display_added')).toMatchObject({ params: ['id', 'nativeId', 'width?'] });
    expect(event(FIXTURE, 'display_metrics_changed')).toMatchObject({
      params: ['changed', 'id', 'nativeId', 'width?'], // "the same keys, plus `changed`"; width optional in the base row stays optional
    });
    expect(event(FIXTURE, 'child_process_gone')).toMatchObject({
      params: ['exitCode?', 'serviceName?', 'type'],
      families: ['electron-main'],
    });
  });

  it('reads retired names (identifiers only, from the first cell) and the not-emitted list (raw tokens)', () => {
    const parsed = parseSpec(FIXTURE);
    expect(parsed.retired).toEqual(['gc_count', 'gc_pause_ms', 'screen_size']);
    expect(parsed.notEmitted).toEqual(['Activity*', 'LowMemory', 'cellular', 'wifi']);
  });

  it('does not read tables outside the inventory headings, nor prose', () => {
    const md = `${FIXTURE}\n## Options\n\n| option | default |\n|---|---|\n| \`captureUrl\` | true |\n`;
    expect(parseSpec(md).traces.map((t) => t.name)).not.toContain('captureUrl');
    expect(parseSpec(md).events.map((t) => t.name)).not.toContain('captureUrl');
  });

  it('lists a family once when a name has several rows in the same table', () => {
    const md = FIXTURE.replace(
      '| `fps` | float, frames per second, one decimal | browser family | no | `=` | rAF |\n',
      '| `fps` | float, frames per second, one decimal | browser family | no | `=` | rAF |\n| `fps` | float, frames per second, one decimal | browser family | no | `=` | again |\n',
    );
    expect(trace(md, 'fps')?.families).toEqual(['shared']);
  });

  it('ends a table at the first non-table line, so a later table needs its own header', () => {
    const md = FIXTURE.replace(
      '| `fps` | float, frames per second, one decimal | browser family | no | `=` | rAF |\n',
      '| `fps` | float, frames per second, one decimal | browser family | no | `=` | rAF |\n\nprose\n\n| `ghost` | value | x | held | = | y |\n|---|---|---|---|---|---|\n| `ghost2` | int | x | no | = | y |\n',
    );
    const names = parseSpec(md).traces.map((t) => t.name);
    expect(names).not.toContain('ghost'); // consumed as a header row
    expect(names).toContain('ghost2');
  });

  it('throws, naming them, when an expected section is missing or empty', () => {
    expect(() => parseSpec('# nothing')).toThrow(/Traces shared with mobile/);
    // a renamed heading is caught twice over: its table is "not a known inventory table", and the section goes missing
    expect(() => parseSpec(FIXTURE.replace('### Retired names', '### Renamed'))).toThrow(/Renamed/);
    expect(() =>
      parseSpec(
        FIXTURE.replace('## System trace inventory', '## Other').replace(
          '### Retired names',
          '### Renamed',
        ),
      ),
    ).toThrow(/Retired names/);
    expect(() =>
      parseSpec(
        FIXTURE.replace('## System event inventory', '## Other').replace(
          '### Node family events',
          '### Other',
        ),
      ),
    ).toThrow(/Node family events/);
  });
});
