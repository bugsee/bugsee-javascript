// A small JSON-with-comments reader for `angular.json`, which Angular's own tooling accepts with `//` and
// `/* */` comments and trailing commas. Reading only: the schematic edits through Angular's workspace API,
// which preserves the file. Kept here so the upload tool needs no Angular dependency at run time.

/** Remove comments and trailing commas, leaving string contents untouched. */
function strip(text: string): string {
  let out = '';
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // A comma directly before `]` or `}` (whitespace between is fine). Strings are matched first so a comma
  // inside one is never touched.
  return out.replace(/"(?:[^"\\]|\\.)*"|,(\s*[\]}])/g, (match, tail?: string) =>
    tail === undefined ? match : tail,
  );
}

/** Parse JSON that may carry comments and trailing commas. Throws on anything else that is not JSON. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(strip(text));
}
