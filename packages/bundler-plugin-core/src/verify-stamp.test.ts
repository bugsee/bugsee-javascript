import { describe, expect, it } from 'vitest';
import { formatIssues, parseScript, verifyStamp, verifyStampedPairs } from './verify-stamp';

const ID = 'b039c7fb-d958-5fe6-b76f-136179e9a728';
const OTHER_ID = '4adb7053-e754-594c-96b5-09c18263b153';
const STUB =
  '\n;!function(){try{var e="undefined"!=typeof window?window:{},n=(new e.Error).stack;n&&(e._bugseeDebugIds=e._bugseeDebugIds||{},e._bugseeDebugIds[n]="' +
  ID +
  '")}catch(e){}}();\n//# debugId=' +
  ID +
  '\n';

const buf = (text: string): Buffer => Buffer.from(text);
const mapJson = (extra: object = {}): string =>
  JSON.stringify({ version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA', ...extra });
const stampedMap = (id = ID): string => mapJson({ debug_id: id, debugId: id });

/** One bundle + its map, before and after a faithful stamp. */
function faithful(): { before: Map<string, Buffer>; after: Map<string, Buffer> } {
  const code = 'console.log(1);\n//# sourceMappingURL=a.js.map\n';
  return {
    before: new Map([
      ['a.js', buf(code)],
      ['a.js.map', buf(mapJson())],
    ]),
    after: new Map([
      ['a.js', buf(code + STUB)],
      ['a.js.map', buf(stampedMap())],
    ]),
  };
}

describe('verifyStamp', () => {
  it('accepts exactly what `sourcemaps inject` produces', () => {
    const { before, after } = faithful();
    expect(verifyStamp(before, after)).toEqual([]);
  });

  it('ignores assets inject did not change (even a bundle that does not parse)', () => {
    const bytes = buf('this is not ( javascript');
    expect(verifyStamp(new Map([['x.js', bytes]]), new Map([['x.js', bytes]]))).toEqual([]);
  });

  describe('(i) a stamped bundle still parses', () => {
    it('flags a bundle the stamp broke', () => {
      const { before, after } = faithful();
      after.set('a.js', buf(`console.log(1);\n//# sourceMappingURL=a.js.map\n${STUB} {{`));
      const issues = verifyStamp(before, after);
      expect(issues.map((i) => i.name)).toContain('a.js');
      expect(issues.find((i) => i.name === 'a.js')?.reason).toMatch(/no longer parses/);
    });

    it('does not blame the stamp for a bundle the parser could not read to begin with', () => {
      const original = 'const x = 1 +;\n'; // already invalid
      const issues = verifyStamp(
        new Map([['a.js', buf(original)]]),
        new Map([['a.js', buf(original + STUB)]]),
      );
      expect(issues).toEqual([]);
    });

    it('parses ES modules, CommonJS and hashbang scripts', () => {
      expect(parseScript('import a from "a"; export default a;')).toBe(true);
      expect(parseScript('module.exports = 1; return 2;')).toBe(true);
      expect(parseScript('#!/usr/bin/env node\nawait 1;')).toBe(true);
      expect(parseScript('with (x) { y }')).toBe(true); // sloppy script, not a module
      expect(parseScript('let = ;')).toBe(false);
    });

    it('uses an injected parser', () => {
      const { before, after } = faithful();
      const seen: string[] = [];
      const issues = verifyStamp(before, after, (code) => {
        seen.push(code);
        return false;
      });
      // Parsed once after, and (because that failed) once before to see who is to blame: it failed too.
      expect(seen).toHaveLength(2);
      expect(issues).toEqual([]);
    });
  });

  describe('(ii) the sourceMappingURL comment', () => {
    it('flags a lost sourceMappingURL comment', () => {
      const { before, after } = faithful();
      after.set('a.js', buf(`console.log(1);\n${STUB}`));
      expect(verifyStamp(before, after).some((i) => /sourceMappingURL/.test(i.reason))).toBe(true);
    });

    it('flags a changed sourceMappingURL target', () => {
      const { before, after } = faithful();
      after.set('a.js', buf(`console.log(1);\n//# sourceMappingURL=b.js.map\n${STUB}`));
      expect(verifyStamp(before, after).some((i) => /sourceMappingURL/.test(i.reason))).toBe(true);
    });

    it('flags a second sourceMappingURL comment sneaking in after the original', () => {
      const { before, after } = faithful();
      after.set(
        'a.js',
        buf(`console.log(1);\n//# sourceMappingURL=a.js.map\n${STUB}//# sourceMappingURL=z.map\n`),
      );
      expect(verifyStamp(before, after).some((i) => /sourceMappingURL/.test(i.reason))).toBe(true);
    });

    it('is not required of a bundle that never had one', () => {
      const code = 'console.log(1);\n';
      const issues = verifyStamp(
        new Map([['a.js', buf(code)]]),
        new Map([['a.js', buf(code + STUB)]]),
      );
      expect(issues).toEqual([]);
    });

    it('does not object to a pointer appearing where there was none (only a lost or changed one is a problem)', () => {
      const code = 'console.log(1);\n';
      expect(
        verifyStamp(
          new Map([['a.js', buf(code)]]),
          new Map([['a.js', buf(`${code}${STUB}//# sourceMappingURL=a.js.map\n`)]]),
        ),
      ).toEqual([]);
    });

    it('accepts the legacy //@ spelling and compares by value', () => {
      const code = 'console.log(1);\n//@ sourceMappingURL=a.js.map\n';
      expect(
        verifyStamp(new Map([['a.js', buf(code)]]), new Map([['a.js', buf(code + STUB)]])),
      ).toEqual([]);
    });
  });

  describe('(iii) the map', () => {
    it('flags a map that is not valid JSON', () => {
      const { before, after } = faithful();
      after.set('a.js.map', buf('{"version":3,'));
      const issue = verifyStamp(before, after).find((i) => i.name === 'a.js.map');
      expect(issue?.reason).toMatch(/not valid JSON/);
    });

    it('flags a map that is not an object', () => {
      const { before, after } = faithful();
      after.set('a.js.map', buf('[1]'));
      expect(verifyStamp(before, after).find((i) => i.name === 'a.js.map')?.reason).toMatch(
        /not valid JSON/,
      );
    });

    it('flags a map with no debugId', () => {
      const { before, after } = faithful();
      after.set('a.js.map', buf(mapJson({ debug_id: ID })));
      expect(verifyStamp(before, after).find((i) => i.name === 'a.js.map')?.reason).toMatch(
        /no debugId/,
      );
    });

    it("flags a map whose debugId differs from its bundle's comment", () => {
      const { before, after } = faithful();
      after.set('a.js.map', buf(stampedMap(OTHER_ID)));
      const reason = verifyStamp(before, after).find((i) => i.name === 'a.js.map')?.reason;
      expect(reason).toContain(OTHER_ID);
      expect(reason).toContain(ID);
    });

    it('flags a stamped bundle whose map was left unstamped', () => {
      const { before, after } = faithful();
      after.set('a.js.map', before.get('a.js.map') as Buffer);
      expect(verifyStamp(before, after).find((i) => i.name === 'a.js.map')?.reason).toMatch(
        /no debugId/,
      );
    });

    it('does not require a map for a bundle that has none', () => {
      const code = 'console.log(1);\n';
      expect(
        verifyStamp(new Map([['a.js', buf(code)]]), new Map([['a.js', buf(code + STUB)]])),
      ).toEqual([]);
    });

    it('flags a bundle with no debugId comment at all when it was changed', () => {
      const { before, after } = faithful();
      after.set('a.js', buf('console.log(1);\n//# sourceMappingURL=a.js.map\n;1;\n'));
      expect(verifyStamp(before, after).find((i) => i.name === 'a.js')?.reason).toMatch(
        /no debugId comment/,
      );
    });

    it('checks a changed map that has no changed bundle for JSON validity only', () => {
      const bytes = buf(mapJson());
      expect(
        verifyStamp(new Map([['a.js.map', bytes]]), new Map([['a.js.map', buf(stampedMap())]])),
      ).toEqual([]);
      expect(
        verifyStamp(new Map([['a.js.map', bytes]]), new Map([['a.js.map', buf('nope')]])).map(
          (i) => i.name,
        ),
      ).toEqual(['a.js.map']);
    });
  });

  describe('(iv) nothing but the stamp was appended', () => {
    it('flags a bundle whose original bytes were altered', () => {
      const { before, after } = faithful();
      after.set('a.js', buf(`console.log(2);\n//# sourceMappingURL=a.js.map\n${STUB}`));
      expect(verifyStamp(before, after).find((i) => i.name === 'a.js')?.reason).toMatch(
        /original bytes/,
      );
    });

    it('does not apply to a bundle that was already stamped (a re-stamp replaces the old stamp)', () => {
      const old = `console.log(1);\n;1;\n//# debugId=${OTHER_ID}\n`;
      const fresh = `console.log(1);\n;1;\n//# debugId=${ID}\n`;
      const issues = verifyStamp(
        new Map([
          ['a.js', buf(old)],
          ['a.js.map', buf(stampedMap(OTHER_ID))],
        ]),
        new Map([
          ['a.js', buf(fresh)],
          ['a.js.map', buf(stampedMap())],
        ]),
      );
      expect(issues).toEqual([]);
    });
  });

  it('only looks at .js/.cjs/.mjs bundles and their .map', () => {
    const issues = verifyStamp(
      new Map([['a.css', buf('a{}')]]),
      new Map([['a.css', buf('changed')]]),
    );
    expect(issues).toEqual([]);
    const cjs = verifyStamp(
      new Map([['a.cjs', buf('1;')]]),
      new Map([['a.cjs', buf(`1;${STUB}`)]]),
    );
    expect(cjs).toEqual([]);
    const mjs = verifyStamp(new Map([['a.mjs', buf('1;')]]), new Map([['a.mjs', buf('1;{{')]]));
    expect(mjs.map((i) => i.name)).toContain('a.mjs');
  });

  it('reports every problem, one entry per file and reason', () => {
    const { before, after } = faithful();
    after.set('a.js', buf('{{'));
    after.set('a.js.map', buf('x'));
    const names = verifyStamp(before, after).map((i) => i.name);
    expect(names).toContain('a.js');
    expect(names).toContain('a.js.map');
  });
});

describe('verifyStampedPairs — a build as it is on disk, after the bundler wrote it', () => {
  const stamped = (id = ID) =>
    buf(`x();\n//# sourceMappingURL=a.js.map\n${STUB.replace(new RegExp(ID, 'g'), id)}`);

  it('accepts a bundle and a map that agree', () => {
    expect(
      verifyStampedPairs(
        new Map([
          ['/o/a.js', stamped()],
          ['/o/a.js.map', buf(stampedMap())],
        ]),
      ),
    ).toEqual([]);
  });

  it('flags a map whose id was lost after the stamp (another plugin regenerated it)', () => {
    const issues = verifyStampedPairs(
      new Map([
        ['/o/a.js', stamped()],
        ['/o/a.js.map', buf(mapJson())],
      ]),
    );
    expect(issues).toEqual([{ name: '/o/a.js.map', reason: expect.stringMatching(/no debugId/) }]);
  });

  it('flags a map with a different id', () => {
    const issues = verifyStampedPairs(
      new Map([
        ['/o/a.js', stamped()],
        ['/o/a.js.map', buf(stampedMap(OTHER_ID))],
      ]),
    );
    expect(issues[0]?.reason).toMatch(/does not match/);
  });

  it('flags a map that is not JSON, and a bundle with a map but no stamp at all', () => {
    expect(
      verifyStampedPairs(
        new Map([
          ['/o/a.js', stamped()],
          ['/o/a.js.map', buf('nope')],
        ]),
      )[0]?.reason,
    ).toMatch(/not valid JSON/);
    const missed = verifyStampedPairs(
      new Map([
        ['/o/b.js', buf('y();\n')],
        ['/o/b.js.map', buf(mapJson())],
      ]),
    );
    expect(missed).toEqual([{ name: '/o/b.js', reason: expect.stringMatching(/not stamped/) }]);
  });

  it('flags a map that carries an id while its bundle lost the comment', () => {
    const issues = verifyStampedPairs(
      new Map([
        ['/o/c.js', buf('z();\n')],
        ['/o/c.js.map', buf(stampedMap())],
      ]),
    );
    expect(issues[0]?.name).toBe('/o/c.js');
  });

  it('ignores a bundle with no map, a stylesheet map, and files that are not bundles', () => {
    expect(
      verifyStampedPairs(
        new Map([
          ['/o/vendor.js', buf('v();\n')],
          ['/o/a.css.map', buf('{}')],
          ['/o/a.css', buf('a{}')],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('formatIssues', () => {
  it('lists the first three and counts the rest', () => {
    const issues = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, reason: `bad ${name}` }));
    expect(formatIssues(issues)).toBe('a: bad a; b: bad b; c: bad c; and 2 more');
    expect(formatIssues(issues.slice(0, 2))).toBe('a: bad a; b: bad b');
  });
});
