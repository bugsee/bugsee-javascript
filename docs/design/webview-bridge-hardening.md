# WebView bridge hardening — proposal for the Android receiver (D1, Wave 0.3)

**Status:** PROPOSAL (2026-07-27). Cross-repo: `javascript` (this repo) + `android/sdk`. **Android moves
first** — decision D1 in `docs/review/REMEDIATION-PLAN.md`. Amends `docs/design/webview-bridge.md` §7/§8.

**Why this exists:** the adversarial review (`docs/review/webview.md`, SEV1 #3 and #4) proved two attacks
against the current bridge, both from ordinary page script — no exploit chain, no native compromise. The
durable fix is **native-side**, which is why this document is addressed to the Android team.

---

## 1. The two proven attacks

Both were demonstrated with working probes; neither is theoretical.

### A. The JS→native sink is a full capture tap

`packages/webview/src/host-bridge.ts:37-40` deliberately re-resolves `global.BugseeBridge` on **every** post
(comment: *"native may register the interface after the script starts"*), with no identity check and no memo of
the first-seen object.

Any script the customer embeds — an ad tag, an analytics snippet, a chat widget — can do:

```js
const orig = window.BugseeBridge.post.bind(window.BugseeBridge);
window.BugseeBridge = { post: s => { exfiltrate(s); orig(s); } };
```

and receive **100% of subsequent capture**, while the SDK keeps working so nothing looks wrong.

This is severe specifically because of a documented default: JS-side redaction is **off unless the integrator
configures a filter** (`launch.ts:105-107` — "content streams un-redacted (`red:false`) and native applies its
canonical filters"), and `captureNetworkBodies` defaults to `true` at 20 KB (`launch.ts:86-89`). So the tapped
stream carries full request URLs (including query-string credentials) and request/response bodies **for the
entire host app**. The SDK becomes the collector for someone else's exfiltration.

**Probe result:** an attacker shim installed *after* `launch()` reported `attacker-intercepted-count: 1`,
`attacker-saw-secret: true`, `sdk-still-works: true`.

### B. `__bugsee_bridge` is an unauthenticated, replaceable page global

`packages/webview/src/launch.ts:340-343` assigns it plainly. `Object.freeze` protects the *object*, not the
*binding* — the descriptor is `{writable: true, configurable: true}`. And `parseControl`
(`host-bridge-control.ts:35-49`) authenticates nothing.

- **Capture suppression:** any page script can call
  `__bugsee_bridge.control('{"b":1,"k":"control","command":"pause"}')` — or `"stop"` — to silently kill
  capture. Nothing is logged, no `onError` fires, and **native is never told the pause was not its own**.
  Probe: `capture-before-pause: 1` → `capture-after-hostile-pause: 0`; a page-issued `stop` produced
  `bye-posted: 1`, `capture-after-hostile-stop: 0`.
- **Obscuring spoof:** replacing the binding with `{control(){}, snapshot(){return '[]'}}` makes native's
  frame-capture pull return an empty rect list while the real secure areas still exist — sensitive regions are
  then recorded unmasked. Probe: `real-snapshot: [{"type":"text","top":5,…}]` vs `spoofed-snapshot: []`.

---

## 2. Why native must move first

The JS side **cannot** fully fix either attack on its own:

- For (A), pinning the sink at launch closes the *post-launch* swap, but a script that runs **before** the SDK
  boots can still install the shim first. In a WebView the SDK is injected at document start, which helps, but
  it is a race, not a guarantee — and the review's own note says as much.
- For (B), `Object.defineProperty(..., {writable: false, configurable: false})` closes the binding half, but the
  control channel still has **no authentication** — the API is reachable by anyone who can read the global name.

The robust fix is the transport itself. **`docs/design/webview-bridge.md:202` already anticipates it**, listing
`WebMessageChannel` (API 26+) as a "richer fallback" next to the `@JavascriptInterface` global. A transferred
`MessagePort`:

- is **not a page global** — it is handed to the page via `onMessage`/`postMessage` and captured in a closure,
  so there is no name for a third-party script to overwrite;
- **cannot be swapped post-handshake** — the port identity is fixed at transfer;
- gives native a **channel-scoped** peer instead of an ambient, world-readable API surface.

**Proposal: promote `WebMessageChannel` from fallback to the PRIMARY transport.**

---

## 3. Proposed changes

### 3.1 Android (`android/sdk`) — moves first

1. **Establish the channel at document start.** Create a `WebMessageChannel`, keep port 1 natively, transfer
   port 2 into the page together with the injected SDK bundle, before any page script runs.
2. **Mint a per-session bridge token** (128-bit, CSPRNG, rotated per session) and deliver it **through the
   port**, never through a global or the injected source text.
3. **Require the token on every inbound message** and on every control command issued downward; reject and
   **report** mismatches rather than failing silently — a mismatch means someone is probing the bridge.
4. **Tell the SDK when a control command did not originate natively.** Today a hostile `pause` is
   indistinguishable from a real one. Native should treat an unauthenticated control as an incident, not a
   no-op.
5. **Keep the legacy `@JavascriptInterface` path** behind an explicit capability flag for API < 26 or for
   embedders that cannot migrate — with its weaker guarantees **documented**, not implied.

### 3.2 JavaScript (this repo) — follows Android

1. **Resolve the sink once and pin it** (`host-bridge.ts:37-40`): capture the port/interface at handshake, hold
   it in closure scope, never re-read a global. Keep the "native may register late" behaviour as a *bounded*
   wait for the handshake, not an unbounded per-post re-resolution.
2. **Make the control global non-replaceable**: `Object.defineProperty(global, '__bugsee_bridge', { value, writable: false, configurable: false })`.
3. **Authenticate `parseControl`** against the session token; drop unauthenticated commands and surface them via
   `onError`.
4. **Prefer the port transport when the handshake advertises it**; fall back to the legacy global only when
   `hello.caps` says the receiver is legacy.

### 3.3 Protocol

- `hello` gains a capability marker for the port transport and carries/negotiates the session token.
- **Wire message shapes are otherwise unchanged** — this is a transport and authentication change, not a
  payload change, so `bridge-protocol.schema.json` should need only the `hello` additions.

### 3.4 Tests (both sides)

The review found `grep -n -i 'freeze\|frozen\|overwrit\|hostile\|malicious' packages/webview/src/*.test.ts`
returns **nothing** — no test exercises any of this. Both repos need hostile-page tests as acceptance criteria:

- a script that swaps `window.BugseeBridge` after launch sees **zero** capture;
- a script that replaces `__bugsee_bridge` cannot pause, stop, or spoof `snapshot`;
- an unauthenticated control command is **rejected and reported**;
- the conformance harness (`webview-conformance.e2e.ts`) validates the `hello` token negotiation.

---

## 4. Open questions for the Android team

1. **Minimum API level.** `WebMessageChannel` is API 26+. What is the Bugsee Android SDK's actual floor, and
   what share of installs would fall back to the legacy path?
2. **Document-start ordering.** Can the port be transferred reliably before first page script on all supported
   API levels, including the cross-origin-subframe injection path (`WebViewReflectionHelper.addDocumentStartScript`)?
3. **Sub-frame composition (D9).** Secure rects are composed across frames via `postMessage`. Does each frame
   need its own port, or does the top frame remain the sole native peer and keep composing?
4. **Rollout.** Both bundles ship independently — `@bugsee/webview` is published to npm and pinned by
   `webview-version.txt`. Confirm the sequencing: native gains the capability, then the JS bundle that uses it
   ships, so an old bundle against a new receiver and vice versa both keep working.
5. **iOS / HarmonyOS.** `WKScriptMessageHandler` has the same ambient-global weakness. Should this proposal be
   generalised now, or is Android-only acceptable for the first pass?

---

## 5. Scope note

This proposal covers **only** the transport/authentication hardening (Wave 0.3). The related canvas-unblocking
work (Wave 1.5) needs a change in the **rrweb fork**, not Android, and per D1 it is sequenced **after** this.
