# @bugsee/webview

The JavaScript side of Bugsee for web content embedded in native app WebViews. It captures console output, network traffic, errors and user input inside the page and streams them across the WebView boundary to the Bugsee native SDK that hosts the WebView.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly in your web app. The native Bugsee SDK for the host app ships this code and injects it into your WebViews for you, and the native side owns the session, the buffer and the upload. If you are building a normal website or web app, install `@bugsee/bugsee` instead.

What it contains:

- `launch(appToken, options)`, which opens a handshake with the native host and streams capture entries to it. It builds on `@bugsee/browser` capture and replaces the local store and upload pipeline with the host bridge.
- The bridge protocol and its JSON schema (`bridge-protocol.schema.json`, published with the package).
- Masking of secure areas of the page, which the native side applies to its own screen capture.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/webview
- Bugsee: https://bugsee.com

## The `url` trace

The WebView writes the embedded page's sanitized address as the `url` trace, exactly as `@bugsee/browser` does (see its README): on by default, `captureUrl: false` turns it off, `urlSanitizer` is your own hook run after the default. The sanitizer rules, limits and the hook contract are the browser package's (see its README).

## License

MIT. See the LICENSE file.
