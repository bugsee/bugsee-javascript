import ts from 'typescript';

/**
 * ONE timeout for the tests that read TypeScript programs from source. Seconds locally, a minute and more on a
 * shared CI runner: a timeout there is a slow machine, never a verdict.
 */
export const TS_PROGRAM_TEST_TIMEOUT_MS = 180_000;

// Parsed source files shared by every program built in a test file, keyed by file name + language version (parsing
// depends on nothing else here). Parsing lib.d.ts and the dependency graph dominates program creation.
const sourceFiles = new Map<string, ts.SourceFile | undefined>();
const programs = new Map<string, ts.Program>();
let previous: ts.Program | undefined;

/**
 * A program for `target` built over a compiler host whose `getSourceFile` is cached across programs, so a later
 * package's program re-uses every file an earlier one already parsed. Memoised per target + compiler options.
 */
export function createSharedProgram(target: string, options: ts.CompilerOptions): ts.Program {
  const merged: ts.CompilerOptions = { ...options, noEmit: true };
  const key = `${target}\0${JSON.stringify(merged)}`;
  const existing = programs.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const host = ts.createCompilerHost(merged, true);
  const underlying = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, ...rest) => {
    const cacheKey = `${fileName}\0${JSON.stringify(languageVersionOrOptions)}`;
    if (sourceFiles.has(cacheKey)) {
      return sourceFiles.get(cacheKey);
    }
    const file = underlying(fileName, languageVersionOrOptions, ...rest);
    sourceFiles.set(cacheKey, file);
    return file;
  };
  const program = ts.createProgram({
    rootNames: [target],
    options: merged,
    host,
    ...(previous === undefined ? {} : { oldProgram: previous }),
  });
  previous = program;
  programs.set(key, program);
  return program;
}
