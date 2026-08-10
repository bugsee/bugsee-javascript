# WebView bridge — trust boundary hardening (Wave 0.3)

**Status:** JS side building · native side to follow · **Supersedes nothing** — extends
[`webview-bridge.md`](webview-bridge.md) §6.2/§7/§9.

## The problem

`@bugsee/webview` treats the WebView **page** as trusted. It isn't: the page is the customer's own web
content, and it routinely contains third-party script (ad tags, analytics, chat widgets, A/B tooling). Two
SEV1s from the 2026-07-27 adversarial review (`docs/review/webview.md`) follow directly from that.

### SEV1-3 — the JS→native sink is re-resolved on every send

`host-bridge.ts` reads `global.BugseeBridge` fresh inside every `post()`. Any script that later assigns

```js
window.BugseeBridge = { post: s => { exfil(s); orig.post(s) } };
```

receives **100% of subsequent capture** — console logs, full request URLs, request/response bodies — while
the SDK keeps working, so nothing looks broken.

What makes it severe is the redaction default, and that default is *correct* on its own terms: the JS
`FilterStore` ships empty because native re-applies the canonical filters on receipt. That protects the
stored bundle. It does nothing for someone reading the wire inside the page. With `captureNetworkBodies`
on by default at 20 KB, the tapped stream carries query-string credentials and bodies for the whole host
app. The SDK becomes the collector.

### SEV1-4 — `__bugsee_bridge` is an unauthenticated, replaceable global

`launch.ts` does `global.__bugsee_bridge = Object.freeze({…})`. `Object.freeze` protects the *object*; the
*binding* stays `{writable: true, configurable: true}`. So:

- **Suppression** — `parseControl` authenticates nothing. Any page script can call
  `__bugsee_bridge.control('{"b":1,"k":"control","command":"pause"}')` to stop capture, or `"stop"` to tear
  the SDK down. Nothing is logged; native is never told the pause wasn't its own.
- **Obscuring spoof** — replace the binding with `{ snapshot: () => '[]' }` and native's frame-capture pull
  returns no rects while real secure areas exist. Password fields render legibly in the captured video,
  because declaring the `obscuring` capability is exactly what made native stand its own masking down.

## Decision: pair the two mechanisms

Neither mechanism alone is sufficient, and they fail in different directions.

| | Closes | Limits |
|---|---|---|
| **Transferred `MessagePort`** | SEV1-3 *structurally* — a transferred port is not a page global, so it cannot be swapped after the handshake | API 26+ only; does not authenticate the **inbound** control path at all |
| **Per-session token** | SEV1-4 — control is rejected unless it carries the secret | Every API level, but a token in an *outbound* message is readable by a tap |

So: **token for the inbound (native→JS) direction on every API level; MessagePort for the outbound
(JS→native) direction where available; pin-on-first-resolve as the outbound floor below API 26.**

There is already a working `WebViewMessageChannel.java` in the Android tree implementing the transferred
port — it is wired to the **legacy** path only (`WebViewWrapper.java`: the advanced bridge "handshakes over
the already-attached `BugseeBridge` interface — no legacy message channel is created"). The native work is
to point that existing machinery at the advanced bridge, not to build it.

## D-A1. Who mints the token: **JS mints it, publishes it once in `hello`**

The alternative was native minting it and injecting it in the bootstrap. Rejected: the Android injector
deliberately passes **no** inline options to the advanced bundle (`WebViewUtils.getAdvancedWebViewScript`:
"Unlike the legacy script it carries no inline launch options — the bundle self-configures over the bridge
handshake"). Making it pass one would change the injection contract for every host.

JS minting needs no injection change:

1. `launch()` mints a 128-bit random `tok` and keeps it in closure — unreachable from the page.
2. `tok` travels **once**, on the `hello` message.
3. Native echoes it on every `control` message.
4. JS rejects any `control` whose token does not match.

The token crosses the outbound channel exactly once, in the first message. A script that taps the bridge
*later* — the actual SEV1-3 threat, an ad tag loading after the SDK — sees only post-`hello` traffic and
never learns it. A script that had already replaced `BugseeBridge` before document-start injection would see
it, but such a script has won the race outright and controls the page regardless.

**`tok` is never repeated on outbound messages after `hello`.** That is the whole reason a later tap cannot
forge control, and it is the constraint most likely to be "optimised" away by someone adding a convenience
field. It must not be.

## D-A2. Enforcement is a **one-way upgrade**, not a flag

Native does not echo tokens today, so requiring them immediately would break every shipped receiver.
Gating on a launch option was rejected for the same reason as D-A1 (native passes no options).

The control channel therefore starts in `unauthenticated` mode and upgrades **irreversibly** to
`authenticated` the first time a `control` message arrives bearing the correct token:

- Before the upgrade, behaviour is exactly as today — no breakage against a legacy receiver.
- After it, every unauthenticated `control` is rejected and reported through `onError`.
- A page script cannot force the upgrade (it needs the token) and cannot undo it (one-way).
- It self-activates the moment native adopts, with no coordinated release.

**Stated limit:** the pre-upgrade window is unprotected. Against a legacy native receiver that never sends a
token, the channel stays unauthenticated forever and SEV1-4(a) is unchanged. This closes the defect for
adopting receivers and is a no-op for the rest; it is not a substitute for native adopting.

## D-A3. The binding is closed, and `stop()` makes the object inert

`Object.defineProperty(global, '__bugsee_bridge', { value, writable: false, configurable: false })` closes
SEV1-4(b) and needs **no protocol change** — it is shippable independently of everything else here.

The consequence is that `stop()` can no longer clear the global (a non-configurable binding cannot be
deleted or reassigned). So teardown switches the object to an **inert** state instead: `control()` becomes a
no-op and `snapshot()` returns `'[]'`. A later `launch()` must therefore reuse the existing binding rather
than install a new one.

`'[]'` is the correct inert snapshot because it is what a stopped SDK already returns, and because native
reads it at frame-capture time — returning nothing at all would throw into `evaluateJavascript`, which is
the SEV1-1 fail-open shape this repo has already fixed once.

## D-A4. Pin the sink on first resolve, and keep using the pinned one

`host-bridge.ts` re-resolves deliberately: "native may register the interface after the script starts". That
requirement is real, so the fix is not to resolve at launch — it is to resolve **once, lazily**, and never
look again:

- Buffer until `BugseeBridge` first appears (unchanged).
- On first sight, **pin** it.
- Every later `post()` uses the pinned reference. A subsequent swap of `window.BugseeBridge` is simply not
  observed — capture keeps flowing to the real native sink and the attacker's shim receives nothing.

Detecting the swap and reporting it was considered and rejected: it costs a global read per post to
report an event the SDK cannot act on, and a page can trigger it at will to spam `onError`.

## Wire changes

Additive; every field optional; a receiver that ignores them behaves exactly as today.

| Message | Field | Direction | Meaning |
|---|---|---|---|
| `hello` | `tok: string` | JS→native | The session token. Sent **once**. Native stores it per-WebView. |
| `control` | `tok: string` | native→JS | Echo. Required once the channel has upgraded (D-A2). |

`bridge-protocol.schema.json` gains both, and the conformance harness asserts the round-trip.

## Native-side work (separate repo)

1. **Store `hello.tok`** per-WebView in `BridgeHandshake` and echo it on every `BridgeControlSender` message.
2. **Point `WebViewMessageChannel` at the advanced bridge** for JS→native, keeping the
   `@JavascriptInterface` as the < API 26 fallback.
3. Optional, and worth doing with (2): reject inbound posts arriving on the `@JavascriptInterface` once a
   port is established, so the fallback cannot be used to bypass the port.

Item 1 alone activates D-A2 and closes SEV1-4(a). Item 2 closes SEV1-3 for API 26+.

## What this does NOT close

Being explicit, because the review's finding was that this boundary had been assumed rather than examined:

- **SEV2-5, forged JS→native messages**, on the `@JavascriptInterface` fallback. A page script can still
  call `window.BugseeBridge.post(…)` and forge `entry`/`report` messages. The MessagePort closes it on API
  26+; below that it stands. Adding the token to outbound messages would close it and would break D-A1, so
  it is deliberately not done.
- **A page script that wins the document-start race.** It sees `hello`, learns the token, and can do
  anything the SDK can. No in-page mechanism defends against this; it is native's injection ordering that
  does.
- **`event.ports` is delivered to every `message` listener.** A page listener registered before the SDK can
  capture the same transferred port. Document-start injection is what makes the SDK first, so the port is a
  defence against *later* scripts — which is precisely the SEV1-3 threat — not against a racing one.
