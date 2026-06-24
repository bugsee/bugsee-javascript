# @bugsee/babel-plugin-component-annotate

A Babel plugin that annotates each host (lowercase-tag) JSX element with
`data-bugsee-component="<ComponentName>"` — the name of the enclosing framework component. At capture time
the `@bugsee/browser` runtime (depth pass D2) reads the nearest annotated ancestor of an interaction/error
target, so clicks and errors attribute to a **component name** that survives minification (the literal name
is emitted at build time). Covers the JSX ecosystems (React / Preact / Solid).

```js
// babel.config.js  (or via your bundler's babel options)
module.exports = {
  plugins: [['@bugsee/babel-plugin-component-annotate']],
};
```

A component is a PascalCase function/class; component elements (`<Widget/>`) are skipped (the attribute would
become a prop, not a DOM attribute). JSX in a nested callback (e.g. a `.map`) is attributed to the enclosing
component. Vue/Svelte Vite plugins are a follow-up. See `docs/design/frontend-adapters.md` §7 (the depth pass).
