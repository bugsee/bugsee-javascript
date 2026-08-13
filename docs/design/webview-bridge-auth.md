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

> **SUPERSEDED by [D-A10](#d-a10-native-mints-the-control-secret-so-the-channel-is-never-open).** Kept for
> the reasoning, which is what led to D-A10. The conclusion below — that JS minting needs no injection
> change — was true but bought a token native cannot attribute, and so a control channel that had to start
> open. Native mints the secret now. Do not implement this section.

The alternative was native minting it and injecting it in the bootstrap. Rejected: the Android injector
deliberately passes **no** inline options to the advanced bundle (`WebViewUtils.getAdvancedWebViewScript`:
"Unlike the legacy script it carries no inline launch options — the bundle self-configures over the bridge
handshake"). Making it pass one would change the injection contract for every host.

JS minting needs no injection change:

1. `launch()` mints a 128-bit `tok` from `crypto.getRandomValues` and keeps it in closure.
2. `tok` travels **once**, on the `hello` message — and only when a native sink is already attached.
3. Native echoes it on every `control` message.
4. JS rejects any `control` whose token does not match.

**Not `randomId()`** (corrected after review round 1). That helper's own header says "Context/correlation
ids are NOT security tokens, so the fallback is safe" — true of a correlation id, false here. Its fallback
is `Math.random()`, and it is reached far more often than its Node-framing suggests: `crypto.randomUUID` is
**secure-context-only**, while Android WebViews routinely host `http://` and `content://` pages. The
attacker is a script in the *same realm*, so it can sample `Math.random()` and recover V8's state.
`crypto.getRandomValues` carries no secure-context gate. **No CSPRNG means no token at all** — a forgeable
token is worse than none, because forging it arms the latch and locks native out of its own channel.

**Withheld when no sink is attached** (also round 1). `hello` is the first message, so with no sink it sits
in the host bridge's backlog and is delivered to whichever sink turns up later — which can be exactly the
late-loading page script SEV1-3 is about. That is the one path by which "sent once, outbound" could still
hand the token to an attacker, so the token is simply not published there. The cost is an unauthenticated
session in the late-attach case, which is the pre-upgrade state the design already accepts.

The token crosses the outbound channel exactly once, in the first message, and only to a sink that is
already attached. A script that taps the bridge *later* — the actual SEV1-3 threat, an ad tag loading after
the SDK — sees only post-`hello` traffic and never learns it. A script that was already there before the SDK
sees it, and controls the page regardless (see *What this does NOT close* — that case is the **default**
configuration today, not a rare race).

**`tok` is never repeated on outbound messages after `hello`.** That is the whole reason a later tap cannot
forge control, and it is the constraint most likely to be "optimised" away by someone adding a convenience
field. It must not be.

**The outbound direction is not the only one that can leak it** (round 1). `parseControl` reads native's
echoed `tok` with `JSON.parse`; while that resolved the *live* global, a page could patch `JSON.parse` and
read the token out of native's own message. The guarantee above is stated outbound-only and was defeated
inbound. The JSON intrinsics are now captured at module load, and every parsed control message has its
prototype cut before any field is read — otherwise `Object.prototype.command = 'stop'` forges a command by
riding native's legitimately-tokened message, needing no token at all.

## D-A2. Enforcement is a **one-way upgrade**, not a flag

Native does not echo tokens today, so requiring them immediately would break every shipped receiver.
Gating on a launch option was rejected for the same reason as D-A1 (native passes no options).

The control channel therefore starts in `unauthenticated` mode and upgrades **irreversibly** to
`authenticated` the first time a `control` message arrives bearing the correct token:

- Before the upgrade, behaviour is exactly as today — no breakage against a legacy receiver.
- After it, every unauthenticated `control` is rejected and reported through `onError`.
- A page script cannot force the upgrade (it needs the token) and cannot undo it (one-way).
- It self-activates the moment native adopts, with no coordinated release.

**"One-way" means per GLOBAL, not per launch** (corrected after round 1). The latch first lived in the
`launch()` closure — but `launch` is itself a page global (`BugseeWebView.launch`) and the singleton guard
reads a mutable carrier field, so a page script could clear the carrier, relaunch, and get a fresh
un-latched channel. The latch now lives on the per-global bridge slot, which a relaunch inherits.

**Stated limit:** the pre-upgrade window is unprotected. Against a legacy native receiver that never sends a
token, the channel stays unauthenticated forever and SEV1-4(a) is unchanged. This closes the defect for
adopting receivers and is a no-op for the rest; it is not a substitute for native adopting.

**Reconsider this trade once both sides ship.** Round 1 pointed out that the compatibility class D-A2 pays
for is currently empty — `@bugsee/webview` is unpublished (`0.0.0`, `private: true`) and the native bridge
is not released either — so "no shipped receiver echoes a token" describes hosts that do not yet exist. The
fail-open default is kept for now because the *native* side ships on its own cadence and a receiver built
from an older doc would otherwise be locked out; but once both are released together, requiring `tok`
unconditionally (dropping the `!authenticated` fall-through) is the stronger position and should be taken.

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

## D-A5. A sub-frame contributes obscuring rects and nothing else

Prerequisite for making the advanced bundle a document-start script (see *What this does NOT close*).

`launch()` gated only the obscuring path on frame position; the handshake and capture ran in **every**
injected frame. That is already live wherever `WebViewDomainAllowlist` is non-empty, and it is what made
all-origins document-start injection unsafe rather than merely broad:

- **One session per WebView.** N frames posting N `hello`s makes the session id, the retained control token
  and the D10 obscuring decision a race between frames — and native now latches the *first* hello, so which
  frame wins is arbitrary.
- **A sub-frame can never receive control.** `evaluateJavascript` targets the top frame, so a token minted
  in a sub-frame is unusable; if native retained it, the top frame's own control would be rejected as a
  mismatch and the channel would be dead.
- **`seq` collides.** Each frame counts from 0, so entries from different frames interleave incoherently.
- **D9 exists to keep Bugsee out of third-party content** (`webview-bridge.md:66`). Running a full capture
  stack inside every ad / OAuth / payment iframe is the opposite of its stated purpose.

So a sub-frame now runs the obscuring composer and returns: no `hello`, no token, no interceptors, no
`client.launch()`. `isLaunched()` reports `false`, which is truthful — that frame captures nothing. The
client object is still constructed and returned so the public signature and the host's `stop()` hold.

**Consequence for the document-start change:** with this in place, all-origins injection produces exactly
one handshake, one token and one capture stream, while giving obscuring the every-frame coverage the legacy
path already has. Without it, that change multiplies sessions instead of widening coverage.

## D-A6. Obscuring reach is a guarantee, not an option

**Bugsee's product guarantee is that privacy-sensitive content is obscured automatically, to the maximum
extent possible.** Reach therefore cannot depend on configuration.

The legacy in-page script already honoured this literally: registered as an ALL-ORIGINS (`["*"]`)
document-start script, gated only by video capture, so masking reaches every subframe including cross-origin
ones. The advanced path did not — its document-start registration returned early whenever
`WebViewDomainAllowlist` was empty (the default), leaving only a top-frame `evaluateJavascript` at
page-ready. And the legacy all-origins registration is **skipped** once the advanced path is active.

So with the real bundle shipped, every iframe's password and payment fields would have rendered unmasked in
the captured video: a regression against legacy, arriving silently with the first published bundle.

**The two concerns are now decoupled — which is what the allowlist was always for:**

| Concern | Reach | Gate |
|---|---|---|
| **Obscuring** | every frame, every origin, always | video capture only |
| **Data capture** | the top frame | D9 allowlist |

D9's stated purpose — *"don't inject Bugsee into third-party content (OAuth/payment/ads)"* — continues to
hold, because **D-A5 is what makes injecting everywhere safe**: an injected sub-frame runs the obscuring
composer and nothing else. Third-party frames contribute mask rects and never a capture stream. Without
D-A5 the two goals genuinely conflicted; with it they do not.

Implemented in `WebViewWrapper.maybeRegisterDocumentStartScript` (Android), mirroring
`maybeRegisterLegacyDocumentStartScript` including its latch-on-SUCCESS retry: a transient reflection
failure must not permanently downgrade a session to top-frame-only masking.

**Registration is unconditional, not video-gated.** Document-start buys two distinct things, and only one
is about pixels: obscuring REACH, and injection ORDER. The trust boundary — pinned sink, closed binding,
control token — assumes the SDK ran before the page's scripts, and that assumption is load-bearing whenever
the SDK captures at all, video or not. So video capture gates masking, never ordering. The legacy path keeps
its video gate because it has no trust boundary to establish: masking really is its only reason to run.

The cost is a sub-frame composer running with video off, producing rects nobody consumes — bounded at one
DOM query and a listener per frame, because D-A5 means a sub-frame does nothing else.

## D-A7. Masking ownership is monotone: native never masks less because of what the page says

**Third design; the first two were structurally wrong, not merely buggy.**

| Attempt | Rule | How it fell |
|---|---|---|
| Round 1 | A `caps:["obscuring"]` claim stands native masking down | The claim arrives from the page. One forged `hello` disabled native masking. |
| Round 2 | Claim **plus rects** — "evidence, not a claim" | Both arrive on the *same* unauthenticated interface, so the attacker simply sends both. It also latched permanently, so the next navigation had no masker at all, and `p:[{}]` (every field defaulting to 0) parsed to a non-empty list of a zero-area rect that still replaced the store. |

The error was the same both times, and it is not a detail: **a decision that REDUCES masking cannot be
authorised by the party being masked.** No amount of evidence from the page fixes that, because the page
supplies the evidence.

**The rule now removes the decision instead of trying to authenticate it:**

- Native's own masking is **never** stood down.
- The mask is the **union** of two independent sources — native's rects and the bridge's.
- The bridge replaces only *its own* source. It can add masking, or withdraw rects it contributed itself.
  It cannot touch native's.
- Rects with no area (`right <= left` or `bottom <= top`) are dropped: a rect that masks nothing is not an
  update, and treating one as an update is what let `[{}]` displace real rects.

Nothing is left for a forged message to switch off, so nothing needs authenticating. The worst case is
masking the same region twice, which costs nothing and cannot expose anything — the correct direction for a
privacy control.

This also **restores** a legitimate behaviour round 2 had to break. Refusing empty payloads was the only way
to stop a page wiping the single shared store; with the sources split, an empty payload is safe and is
applied again. That matters: the JS side sends `[]` whenever a document genuinely has no secure areas, and
sends a **full-screen fail-closed rect** when collection throws — so under the round-2 rule one transient
failure left the entire recording permanently blacked out.

**Consequence for D10.** "The advanced SDK fully replaces legacy" is no longer something native negotiates
over the wire, because the wire cannot carry a trustworthy answer. If that hand-over is wanted later, it has
to be decided from something native controls — e.g. the resolved bundle version stamped in at build time —
never from `caps`.

## D-A8. The interface's lifetime is bound to the bundle's — and the nonce that must come before it goes live

**Found by review round 5, after four rounds had walked past it.** Every earlier round reasoned about the
*advanced* path, because that is what the token work touched. The exposure was on the **default** one.

`WebViewWrapper.initialize()` attached the `BugseeBridge` `@JavascriptInterface` **unconditionally**, before
and outside the branch that chooses the advanced bundle over the legacy script. `webview-version.txt` is the
build-time placeholder `0.0.0` in every released build, so `isAdvancedScriptUsable()` is false, no
`@bugsee/webview` SDK is ever loaded — and yet the interface was published to every page anyway. The only
party able to speak on it was the page. Shipped in 7.1.0 and 7.1.1.

**Rule: no legitimate speaker, no interface.** `attach` now sits inside
`isAdvancedWebViewCaptureEnabled() && isAdvancedScriptUsable()`, the same gate that decides whether the
bundle is injected at all. In every shipped build the interface simply does not exist, which closes the
forged `hello`, `secure`, `report`, `entry` and `batch` routes at once rather than one at a time.

Both terms of that gate are now decided **once per WebView**. `isAdvancedScriptUsable()` already memoized;
the option term was a live re-read, so the attach decision and the injection decision consulted it
independently and could in principle disagree — which reconstructs the exact state the gate exists to
prevent, an interface attached with no bundle behind it.

Two bounds were added alongside it, since the surface returns when the bundle does: `batch` unrolls at most
`MAX_BATCH_ENTRIES` (1000) entries, and one `secure` message contributes at most `MAX_SECURE_AREAS` (4096)
areas — with the list's *capacity* clamped too, so a payload cannot pre-allocate before a rect is validated.

The secure-area bound is on the **scan**, not on the accepted output. Bounding only the result list lets a
payload of degenerate areas iterate freely: `{}` defaults every field to `0`, is dropped as zero-area, and
so never grows the result — the cap reads as satisfied while the loop runs the attacker's chosen length.

It is also sized as an abuse bound a real document cannot reach, **not** as a routine truncation, because
truncating here is not a safe direction. The tempting argument — these rects are unioned with native's own,
so dropping surplus ones cannot unmask what native masked — holds only while native *has* a source of its
own. On the advanced path it does not (see below), so every dropped rect would be a field left legible.

### D-A9. The mask comes from the PULL, so the forgeable push decides nothing

The advanced path had an unforgeable channel all along and was not using it.

`BridgeControlScript.snapshotExpression()` evaluates
`(window.__bugsee_bridge && window.__bugsee_bridge.snapshot()) || "[]"`, and `__bugsee_bridge` is installed
on a **closed binding** (`writable:false, configurable:false` — the SEV1-1 fix). A page script therefore
cannot swap the object to make `snapshot()` return rects of its choosing, and a page that pre-owns the name
makes the SDK fail closed rather than advertise a surface it does not have. `BridgeControlSender` even
exposes `requestSnapshot(...)` for it — with **no production caller**. The pull was built and left unwired,
so native's only source of bridge rects was the pushed `secure` message, which any frame can forge.

Every previous attempt tried to decide whether to *trust* the payload — a `caps` claim, a claim plus
"evidence", split sources. All of them argued about attribution on a channel where the sender cannot be
identified. The rule now removes the payload from the decision entirely:

- `onSecure` **discards** `secure.payload`. The message is a freshness signal — "something changed,
  re-read the truth" — and nothing more.
- The rects come from `requestSnapshot`, parsed out of the double-encoded `evaluateJavascript` result.
- At most one pull is outstanding (`mSnapshotIssuedAt`), because the trigger is free for a page to spam and
  every pull marshals an `evaluateJavascript` onto the main thread.

A forged push now costs a re-read of reality. A suppressed one costs freshness, not correctness. And
withdrawal still works — an empty *snapshot* is the legitimate signal, which the page cannot forge.

This is why the advanced path does **not** need the nonce for masking, and the legacy path does: legacy is
push-only and has no equivalent of the closed binding to pull against.

### The precondition this does NOT satisfy

Gating `attach` makes today safe by removing the surface. It does not make the surface safe. **Before
`webview-version.txt` carries a real bundle, this must be closed:**

Once the advanced path is live, `BugseeBridge` is a page-reachable global again, and on that path the legacy
obscuring script is *not* injected — so the D-A7 union has exactly **one** member, the bridge's. Every rect
protecting a password field then originates from a channel any script in any frame can post to. D-A7's
guarantee ("native never masks less because of what the page says") holds only while native has a source of
its own; on the advanced path it has none, and a forged `secure` with a smaller rect set withdraws real
masking. The monotone rule is intact in structure and empty in practice.

Two ways out, and they are not equivalent:

1. **Inject legacy obscuring on both paths**, so native always has an independent source. Rejected as-is:
   `getJSScript()` is the *whole* legacy in-page script — obscuring plus capture — and `WebViewJSListener`
   is attached on both paths, so running it under the advanced bundle double-captures. It would need the
   obscuring portion split into its own asset first.
2. **Authenticate the channel with a nonce native controls** (preferred). Native mints a per-document random
   nonce, interpolates it into the document-start bundle it injects, and rejects any inbound message without
   it. The bundle holds it in closure scope, so page scripts cannot read it back. This is the one shape that
   actually distinguishes our SDK from the page, because the secret travels by a route the page never sees —
   unlike `tok` (D-A1), which JS mints and any script can mint too.

**CLOSED — by option 2, plus one thing this section did not anticipate.** D-A10/D-A11 gave native a secret
the page never sees, so inbound messages are authenticated. D-A9/D-A12 went further and removed the need to
trust the inbound payload for masking at all: native re-reads the rects from a closed binding it can ask
directly. The version bump is no longer gated on this.

## D-A10. Native mints the control secret, so the channel is never open

`tok` (D-A1) is minted by JS and published in `hello` so native can learn it. That is the whole problem:
`hello` arrives on an interface any frame can post to, so native cannot tell the SDK's token from a page
script's. The channel therefore had to start **open** and wait to latch on the first correctly-tokened
message — and a page could `__bugsee_bridge.control({cmd:"stop"})` inside that window, permanently when the
page realm had no CSPRNG and `mintControlToken` returned `undefined`.

Native mints it instead: 128 bits of `SecureRandom`, interpolated into the bundle native injects as
`BugseeWebView.launch("<token>",{controlNonce:"…"})`. The SDK holds it in closure scope and requires it on
every inbound control message **from the first one** — no publication, no open period, no latch. `onHello`
retains nothing.

## D-A11. A second secret authenticates capture, and it is separate on purpose

`BugseeBridge.post` is reachable from every frame, so any script could inject fabricated
`log`/`network`/`events`/`traces`/`breadcrumbs` entries — and with no rate limit, loop until the native ring
buffer evicted the genuine capture of the bug being reported. That last part is why it is not merely a
data-integrity concern: it destroys evidence.

The SDK now stamps every outgoing message with `n`, and native drops anything that does not carry it, before
any delegate effect. The gate covers **every** inbound kind: a forged `hello` drives native into replying to
a page script, which is state change on an unauthenticated message.

**Why two secrets and not one.** The capture nonce has to travel the wire to do its job, so a script that
shadowed `BugseeBridge` before the SDK pinned it will read it — survivable, since such a script can already
forge capture. Reusing the control secret would mean that same exposure also granted `cmd:"stop"`, turning a
capture tap into a kill switch.

**Skew fails closed and loudly.** A bundle older than native stamps nothing, so native drops 100% of its
capture. That is the correct direction, but it was silent — indistinguishable from "the WebView was never
used" — so the first rejection is now logged once, naming both likely causes.

## D-A12. The pull needs more than one trigger

D-A9 moved the mask to the snapshot pull but left `onSecure` as its only caller, and a comment claiming the
pull "also runs on the control path" to justify why a suppressed push was harmless. **No such caller
existed.** Any state with no admitted push therefore left the advanced path — which has no legacy mask
source — masking nothing at all. Two ordinary states produce exactly that:

- the JS obscuring channel fails to start (`probe()` false), so it posts nothing;
- a Bugsee `stop()`→`launch()` re-wraps a WebView whose loaded page still runs the **previous** session's
  SDK, stamping a nonce the new receiver rejects — so every push is dropped until the user navigates.

The pull works in both cases: it is an outbound `evaluateJavascript`, not a nonce-gated inbound message. So
native asks whenever a page becomes ready, as well as on a push.

Two further properties the pull needs, each found only after the previous fix shipped:

- **It expires.** A guard only a callback can clear is unsafe when the callback is not guaranteed to run —
  Android drops it on renderer death, `destroy()` mid-evaluation, or a navigation that tears down the JS
  context. One lost callback froze the mask permanently.
- **It has a generation.** Once a deadline lets two pulls overlap, a late answer from an expired pull would
  release the slot a newer pull holds and overwrite its rects. The issue stamp is the pull's identity, and
  the callback proves it still owns the slot before acting.
- **A signal arriving mid-pull is remembered.** The in-flight answer may predate the change that signal
  announces, so coalescing it away lost it entirely; a dirty flag drives exactly one re-pull.

## Wire changes

Additive; every field optional; a receiver that ignores them behaves exactly as today.

| Message | Field | Direction | Meaning |
|---|---|---|---|
| `hello` | `tok: string` | JS→native | **Superseded by D-A10.** The JS-minted token; native no longer stores or echoes it. |
| `control` | `tok: string` | native→JS | The secret NATIVE minted (D-A10). Required on every control message, from the first. |
| *all JS→native* | `n: string` | JS→native | The capture nonce (D-A11). Native drops any message without it. |

`bridge-protocol.schema.json` gains both, and the conformance harness asserts the round-trip.

## Native-side work (separate repo)

1. ~~**Store `hello.tok`** per-WebView and echo it.~~ **DONE differently — see D-A10.** Native mints its own
   secret and injects it; `BridgeHandshake` carries no token at all, because a reply built from `hello.tok`
   is a reply carrying a value the page could have minted.
2. **Point `WebViewMessageChannel` at the advanced bridge** for JS→native, keeping the
   `@JavascriptInterface` as the < API 26 fallback.
3. Optional, and worth doing with (2): reject inbound posts arriving on the `@JavascriptInterface` once a
   port is established, so the fallback cannot be used to bypass the port.

Item 1 is superseded by D-A10, which closes SEV1-4(a) outright rather than via the D-A2 upgrade — there is
no open period to activate. Item 2 closes SEV1-3 for API 26+.

## What this does NOT close

Being explicit, because the review's finding was that this boundary had been assumed rather than examined:

- **SEV2-5, forged JS→native messages**, on the `@JavascriptInterface` fallback. A page script can still
  call `window.BugseeBridge.post(…)` and forge `entry`/`report` messages. The MessagePort closes it on API
  26+; below that it stands. Adding the token to outbound messages would close it and would break D-A1, so
  it is deliberately not done.
- **A page script that runs before the SDK.** It sees `hello`, learns the token, and can do anything the
  SDK can. No in-page mechanism defends against this.

  > **This is the DEFAULT configuration, not an exotic race** — corrected after review round 1, where it
  > was filed under "wins the document-start race" and treated as unlikely. It is not: with an empty
  > `WebViewDomainAllowlist` (the D9 default) `maybeRegisterDocumentStartScript` returns immediately, and
  > the only remaining path is `injectTopFrameScript`, an `evaluateJavascript` fired from
  > `onPageCommitVisible`/`onPageFinished` — **after** the page's own scripts have run.
  >
  > Everything in this section is therefore load-bearing for ordinary pages, not just hostile ones, and the
  > in-page defences below are a second line rather than the first.
  >
  > **CLOSED (D-A6).** The advanced bundle is registered as an all-origins document-start script,
  > **unconditionally** — so the SDK runs before the page's own scripts, in every frame, on every
  > navigation. The pinned sink, the closed binding and the token now have the ordering they always
  > assumed.
  >
  > Registration is deliberately *not* gated on video capture. Video decides whether there are pixels to
  > mask; it says nothing about whether the SDK gets to run first, and the capture tap (SEV1-3) is live
  > whenever the SDK captures at all. The residual exposure is a host that disables the advanced path
  > entirely, or a build where document-start reflection is unavailable on every tier — both fall back to
  > page-ready injection, where this section's original caveat still applies.

- **`event.ports` is delivered to every `message` listener.** A page listener registered before the SDK can
  capture the same transferred port. Document-start injection is what would make the SDK first, so the port
  defends against *later* scripts — which is the SEV1-3 threat — and not against an earlier one. See the
  caveat above: today the SDK is generally not first.
