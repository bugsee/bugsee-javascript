---
'@bugsee/protocol': minor
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/performance': minor
'@bugsee/nextjs': minor
'@bugsee/core': patch
'@bugsee/replay': minor
'@bugsee/bugsee': minor
---

New `url` system trace and a sanitizer for the page's own address (C11, C21, C25).

- `@bugsee/browser`, `@bugsee/webview` (and so Electron renderers): the `url` trace, the page's sanitized `location.href` as a held step curve written at start and on every navigation. On by default and independent of the performance extension; new launch options `captureUrl` (default `true`; any non-boolean turns it off and is reported) and `urlSanitizer` (a hook run after the default, its string result written as given, `null` writes nothing, a throw is reported and writes nothing). The navigation source's `navigate` detail gains the absolute `href`, and `createBrowserNavigationSource` an `isolated` mode.
- `@bugsee/protocol`: new `sanitizeLocationUrl`: scheme handling (`data:`/`javascript:`/`vbscript:` reduced to `<scheme>:%3Credacted%3E`, `blob:`/`filesystem:` to their inner origin with no userinfo, `file:` to `file:///.../<last segment>`), and a bounded scan of URLs nested in a query value. `sanitizeUrl` (network URLs) is unchanged.
- `@bugsee/nextjs`: the navigation breadcrumb no longer writes the raw `href` (message and data are sanitized).
- `@bugsee/performance`: the transaction name of a URL-detected navigation is sanitized (adapter-supplied route names are kept as given).
- `@bugsee/core`: `urlSanitizer` is kept across `relaunch()` (a redaction hook).
- Review round: the pageload transaction name and resource-timing span descriptions are sanitized too; a `file:` page is named by its last segment. The replay stream's opening Meta `href` is sanitized (`@bugsee/replay`). The page-address denylist adds the exact keys `code`, `state`, `session`, `sessionid`, `sid`, `sig`, `signature`, `ticket`, `otp` (`key` and `t` are not redacted), the hash-router query is scanned, nested URLs and relative return paths are read tolerantly (raw, half-encoded or double-encoded, two levels), raw `https:/u:p@a.com`, backslash and `file:C:\...` forms are normalised like a browser would, and an address over 8192 characters is clipped and marked.
- The navigation source is now shared per window through the carrier (`navigationSourceFor`, used by the `url` trace and the umbrella's navigation transactions; the umbrella now binds it to the window passed to `launch`, not the host global) and its `history` patching is order-safe: it restores only when its wrapper is still outermost, otherwise leaves a pass-through and never removes another library's wrapper (C23).
- `urlSanitizer` results are clipped at 2048 characters; when the hook drops (`null`) or throws, the previous URL stays held.
