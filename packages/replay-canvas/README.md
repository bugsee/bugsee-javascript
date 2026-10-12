# @bugsee/replay-canvas

Opt-in canvas recording for Bugsee session replay: makes `<canvas>` content (2D and WebGL) show up in replays instead of a blank box. Browser only.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

You do not need to install this package. It is a dependency of `@bugsee/browser` (and so of `@bugsee/bugsee`) and is loaded lazily, only when you enable it with the `replay.canvas` launch option. It is off by default. Install `@bugsee/bugsee` instead:

```bash
npm install @bugsee/bugsee
```

## Usage

```ts
import { launch } from '@bugsee/bugsee';

await launch('YOUR_APP_TOKEN', {
  replay: {
    canvas: { fps: 2, quality: 0.6, imageType: 'image/webp' },
  },
});

// Or enable it with defaults:
// await launch('YOUR_APP_TOKEN', { replay: { canvas: true } });
```

Canvas pixels are recorded unmasked. Enable it only for canvases that never show sensitive data. To record only specific canvases, set `replay.blockAllCanvas: true` and mark the ones to record with the `bugsee-show` class or a `data-bugsee-show` attribute.

## Options

The `replay.canvas` option takes `true` or an object:

- `fps`: snapshots per second (clamped to 1 to 60, default `2`), or `'all'` to record every draw call (heavier).
- `quality`: snapshot quality from 0 to 1, default `0.6`.
- `imageType`: `'image/webp'` (default) or `'image/jpeg'`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/replay-canvas
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
