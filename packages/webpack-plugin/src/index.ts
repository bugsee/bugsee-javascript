// @bugsee/webpack-plugin — the Webpack entry over @bugsee/bundler-plugin-core. At build end (afterEmit) it
// drives `bugsee-cli` to inject debug-IDs, upload the source-maps, and delete the client `.map`s (privacy).
// See docs/design/source-maps.md.
//
//   const { bugseeWebpackPlugin } = require('@bugsee/webpack-plugin');
//   module.exports = { plugins: [bugseeWebpackPlugin({ appToken: '…' })] };
import { type BugseePluginOptions, bugseeUnplugin } from '@bugsee/bundler-plugin-core';

export type { BugseePluginOptions };

/** The Bugsee Webpack plugin factory: `bugseeWebpackPlugin(options)` → a Webpack plugin. */
export const bugseeWebpackPlugin = bugseeUnplugin.webpack;

export default bugseeWebpackPlugin;
