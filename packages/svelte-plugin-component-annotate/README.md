# @bugsee/svelte-plugin-component-annotate

A Svelte preprocessor that labels the DOM elements rendered by your Svelte components with the component's name, so Bugsee can attribute clicks and errors to a component even after minification.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly as a dev dependency in Svelte and SvelteKit projects. It is optional: without it, Bugsee still captures everything, but component names in minified production builds may be mangled. It works with the Bugsee browser SDK (`@bugsee/bugsee`), which reads the label back at runtime.

## Install

```sh
npm install --save-dev @bugsee/svelte-plugin-component-annotate
# or
pnpm add -D @bugsee/svelte-plugin-component-annotate
# or
yarn add -D @bugsee/svelte-plugin-component-annotate
```

Requires `svelte` 4 or newer (peer dependency).

## Usage

```js
// svelte.config.js
import { componentAnnotatePreprocessor } from '@bugsee/svelte-plugin-component-annotate';

export default {
  preprocess: [componentAnnotatePreprocessor()],
};
```

On SvelteKit 3 there is no `svelte.config.js`; pass `preprocess` to the `sveltekit()` Vite plugin instead (see the [`@bugsee/sveltekit` README](../sveltekit/README.md)).

Each host element (lowercase tag) in a `.svelte` file gets a `data-bugsee-component="<ComponentName>"` attribute. The name comes from the file name (`UserCard.svelte` becomes `UserCard`). For `index.svelte` and SvelteKit route files (`+page`, `+layout`, `+error`) the enclosing directory name is used. Elements you already annotated by hand are left alone, and component instances (`<Child />`) get no attribute.

## Options

- `renderSpans`: also record a render span for each component's initialization (mount) in your performance data. Default `false`. It requires `@bugsee/svelte` to be installed.

```js
preprocess: [componentAnnotatePreprocessor({ renderSpans: true })],
```

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/svelte-plugin-component-annotate
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
