# @bugsee/babel-plugin-component-annotate

A Babel plugin that labels the DOM elements rendered by your React, Preact or Solid components with the component's name, so Bugsee can attribute clicks and errors to a component even after minification.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly as a dev dependency. It is optional: without it, Bugsee still captures everything, but component names in minified production builds may be mangled. It works with the Bugsee browser SDK (`@bugsee/bugsee`), which reads the label back at runtime.

## Install

```sh
npm install --save-dev @bugsee/babel-plugin-component-annotate
# or
pnpm add -D @bugsee/babel-plugin-component-annotate
# or
yarn add -D @bugsee/babel-plugin-component-annotate
```

Requires `@babel/core` 7 (peer dependency).

## Usage

Add the plugin to your Babel config, or to the Babel options of your bundler.

```js
// babel.config.js
module.exports = {
  plugins: [['@bugsee/babel-plugin-component-annotate']],
};
```

At build time, each host JSX element (lowercase tag such as `<button>` or `<div>`) gets a `data-bugsee-component="<ComponentName>"` attribute with the name of the component that renders it. A component is a PascalCase function or class, including `const Foo = () => ...` and `const Foo = memo(...)` or `forwardRef(...)`. Component elements (`<Widget />`) are not annotated.

The plugin takes no options. Vue uses a runtime mixin from `@bugsee/vue` instead, and Svelte uses `@bugsee/svelte-plugin-component-annotate`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/babel-plugin-component-annotate
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
