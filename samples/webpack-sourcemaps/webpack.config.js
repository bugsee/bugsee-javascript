// Webpack 5 config for the "Markdown Notes" sample — the copy-paste reference for wiring
// @bugsee/webpack-plugin into a real webpack build. See docs/samples/PLAN.md §5.7 and this
// sample's README.md ("The source-map half") for what each option below is exercising.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import dotenv from 'dotenv';
import webpack from 'webpack';
import { bugseeWebpackPlugin } from '@bugsee/webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parsed directly (not `dotenv.config()`, which silently no-ops a var that's already in
// process.env) so the plugin's OWN token can be overridden per-invocation by a test script
// (`build:bad-token-*`, see package.json) while the CLIENT bundle still always gets the REAL
// token below — a broken *upload* must not also break the deployed app's ability to report.
const envPath = path.join(__dirname, '.env');
const fileEnv = existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {};

// A build counter so every production build we upload source maps for is identifiable in the
// dashboard (appBuild), and so building twice in a row produces two distinct debug-IDs (byte
// identical output -> identical debug-id -> bugsee-cli's DuplicateSymbolsFoundError on re-upload;
// bumping the JS below via BUILD_STAMP forces distinct output even with no source changes).
const buildCounterFile = path.join(__dirname, '.build-counter');
function nextBuildCounter() {
  let n = 0;
  try {
    n = Number.parseInt(readFileSync(buildCounterFile, 'utf8').trim(), 10) || 0;
  } catch {
    // first build
  }
  n += 1;
  try {
    writeFileSync(buildCounterFile, String(n));
  } catch {
    // best-effort; a missing counter file just restarts at 1 next time
  }
  return String(n);
}

export default (_env, argv) => {
  const isProd = argv.mode === 'production';
  const appBuild = isProd ? nextBuildCounter() : 'dev';

  // ---- @bugsee/webpack-plugin's OWN options (plugin options "in full" — PLAN §5.7a) ----
  const pluginToken = process.env.BUGSEE_APP_TOKEN ?? fileEnv.BUGSEE_APP_TOKEN ?? '';
  const pluginEndpoint =
    process.env.BUGSEE_ENDPOINT ?? fileEnv.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com';
  const dryRun = process.env.BUGSEE_DRY_RUN === 'true';
  const forceDisabled = process.env.BUGSEE_DISABLED === 'true';
  const keepMaps = process.env.BUGSEE_KEEP_MAPS === 'true';
  // Default TRUE: this sample's recommended posture is "a telemetry side effect that silently
  // ships an unsymbolicated build is worse than a failed build" (PLAN §5.7f). Explicit
  // `BUGSEE_FAIL_ON_ERROR=false` (build:bad-token-soft) demonstrates the library default instead.
  const failOnError = process.env.BUGSEE_FAIL_ON_ERROR !== 'false';

  // ---- the CLIENT bundle's launch config — ALWAYS the real token, never the overridden one ----
  const clientToken = fileEnv.BUGSEE_APP_TOKEN ?? '';
  const clientEndpoint = fileEnv.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com';

  return {
    mode: isProd ? 'production' : 'development',
    entry: './src/main.ts',
    // (b) PLAN §5.7: production builds ship `hidden-source-map` — a real .map is written
    // next to each chunk (bugsee-cli finds it via the `<bundle>.map` sibling convention), but the
    // shipped bundle carries NO `//# sourceMappingURL=` comment, so a user's browser devtools/
    // network tab never exposes the map. Dev keeps fast, high-fidelity maps.
    devtool: isProd ? 'hidden-source-map' : 'eval-source-map',
    output: {
      path: path.join(__dirname, 'dist'),
      filename: isProd ? 'assets/[name].[contenthash:8].js' : 'assets/[name].js',
      chunkFilename: isProd ? 'assets/[name].[contenthash:8].chunk.js' : 'assets/[name].chunk.js',
      clean: true,
      publicPath: '/',
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: { loader: 'ts-loader', options: { transpileOnly: true } },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: [
            isProd ? MiniCssExtractPlugin.loader : 'style-loader',
            // sourceMap: false in production ONLY — see FINDINGS.md F-1: @bugsee/bundler-plugin-core's
            // `debug-files upload` walks EVERY `*.map` under the output dir, but `sourcemaps inject`
            // only injects a debug-ID into JS-originated maps, so a CSS source map alongside the JS
            // ones (the css-loader/mini-css-extract-plugin default) makes bugsee-cli reject the WHOLE
            // upload batch (exit 11, "source map has no debug_id"), which — with this sample's
            // recommended `failOnError: true` — fails the entire build, and even with the library's
            // own default (`failOnError: false`) silently skips deleting EVERY client `.map` (js
            // included), a privacy regression. Not emitting a CSS map in prod sidesteps it; the
            // underlying defect is unfixed (this sample does not touch packages/).
            { loader: 'css-loader', options: { sourceMap: !isProd } },
          ],
        },
      ],
    },
    resolve: { extensions: ['.ts', '.js'] },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/index.html',
        title: 'Markdown Notes — Bugsee webpack-sourcemaps sample',
      }),
      ...(isProd ? [new MiniCssExtractPlugin({ filename: 'assets/[name].[contenthash:8].css' })] : []),
      new webpack.DefinePlugin({
        'process.env.BUGSEE_APP_TOKEN': JSON.stringify(clientToken),
        'process.env.BUGSEE_ENDPOINT': JSON.stringify(clientEndpoint),
        'process.env.APP_BUILD': JSON.stringify(appBuild),
      }),
      // (a) @bugsee/webpack-plugin under test — every BugseePluginOptions field is reachable from
      // an env var so the npm scripts in package.json can drive each variant without editing this
      // file (dry-run / disabled / keep-maps / bad-token loud+soft / signal-kill via BUGSEE_CLI_PATH,
      // read directly by @bugsee/bundler-plugin-core's resolveBugseeCli — not plumbed here).
      bugseeWebpackPlugin({
        appToken: pluginToken,
        endpoint: pluginEndpoint,
        appVersion: '1.0.0',
        appBuild,
        // Disabled outside a production build regardless (a dev server never has a finished
        // `dist` to symbolicate) OR when explicitly forced off (build:disabled).
        disabled: !isProd || forceDisabled,
        dryRun,
        deleteMaps: !keepMaps,
        failOnError,
        onError: (error) => {
          // eslint-disable-next-line no-console
          console.error('[bugsee-webpack-plugin] source-map upload failed:', error);
        },
      }),
    ],
    devServer: {
      port: 5321,
      static: { directory: path.join(__dirname, 'dist') },
      proxy: [{ context: ['/api'], target: 'http://localhost:5346', ws: true, changeOrigin: true }],
      // S5 deliberately throws uncaught errors from the Scenario panel; webpack-dev-server's default
      // error overlay is a full-screen iframe that intercepts pointer events over the whole page,
      // blocking every click AFTER the first uncaught throw (a test-harness/dev-UX issue, not an SDK
      // one — @bugsee/browser's own `window.onerror` detection still fires correctly either way).
      client: { overlay: false },
    },
    stats: 'errors-warnings',
  };
};
