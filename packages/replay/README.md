# @bugsee/replay

Session replay for the Bugsee JavaScript SDK: records the page DOM (with the Bugsee-hardened rrweb recorder) so a report can be played back. Browser only.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

You do not need to install this package. It is a dependency of `@bugsee/browser`, which `@bugsee/bugsee` uses in the browser. It is loaded lazily (as a separate chunk) and recording is on by default, controlled by the `replay` launch option. Install `@bugsee/bugsee` instead:

```bash
npm install @bugsee/bugsee
```

## Usage

```ts
import { launch } from '@bugsee/bugsee';

// Replay is on by default. Customise it with an options object...
await launch('YOUR_APP_TOKEN', {
  replay: {
    maskAllText: true,
    blockSelector: '.private',
  },
});

// ...or opt out entirely (the replay chunk is then never loaded).
await launch('YOUR_APP_TOKEN', { replay: false });
```

## Options

The `replay` option takes `false`, `true` or an object. Masking is fail-closed: text, inputs and media are masked or blocked unless you relax them.

- `maskAllText`: mask every text node, default `true`.
- `maskAllInputs`: mask every input value, default `true`.
- `blockAllMedia`: block all media and iframes, default `true`. A blocked iframe is recorded as an empty placeholder of the same size: its document, text, inputs and live changes are never recorded. Mark an iframe `.bugsee-show` to record it (its content is then masked like the rest of the page). Limit: a defence-in-depth guard re-checks every iframe against your `unblockSelector` on a detached copy of the element, so keep that selector to the iframe's own attributes (`.bugsee-show`, `iframe[data-embed="x"]`). A contextual selector (`#trusted iframe`, `.x > iframe`, `:first-child`) is honoured by the recorder but the guard removes that iframe's document and reports an error (#123).
- `maskTextSelector`, `blockSelector`, `ignoreSelector`: extra CSS selectors to mask, block or ignore.
- `checkoutEveryNms`: full-snapshot interval in milliseconds, default `60000`.
- `canvas`: opt-in canvas recording, see `@bugsee/replay-canvas`.

Replay needs a DOM. During server rendering nothing is recorded, whatever the option says.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/replay
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
