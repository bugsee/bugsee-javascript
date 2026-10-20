---
'@bugsee/bundler-plugin-core': patch
---

The Rollup plugin bakes the app version/build (`__BUGSEE_APP_VERSION__` / `__BUGSEE_APP_BUILD__`) into each rendered chunk (Rollup has no `define`; the same detected identity the source-map upload uses, with an exact source map). The chunk is walked on Rollup's own AST, so only real global reads are replaced: a constant name inside a string, template text, comment, regex literal, property name or object key is left alone, a shorthand `{ X }` becomes `{ X: value }`, and a local binding that merely shares the name (a parameter, `var`/`let`/`const`, function, class, import or catch parameter) is never touched. A chunk that mentions a constant but cannot be examined (no parser in the context, or a parse failure) is left as Rollup produced it and `this.warn` says once per output directory that the identity was not baked.
