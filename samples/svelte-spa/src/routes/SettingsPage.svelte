<script lang="ts">
  import { getClient } from '../bugsee';
  import type { AttributeValue } from '@bugsee/svelte';

  let userId = $state('');
  let currentUserId = $state<string | null>(null);
  let attrType = $state<'string' | 'number' | 'boolean' | 'string[]'>('string');
  let attrKey = $state('');
  let attrValue = $state('');
  let attrsDump = $state('');
  let singleAttrDump = $state('');
  let drawerOpen = $state(false);
  let maskedField = $state('');
  let shownField = $state('');
  let ignoredField = $state('');

  function refresh(): void {
    const client = getClient();
    currentUserId = client?.getUserIdentifier() ?? null;
    attrsDump = client ? JSON.stringify(client.getAllAttributes()) : '';
  }
  refresh();

  function setUserId(): void {
    getClient()?.setUserIdentifier(userId);
    refresh();
  }
  function clearUserId(): void {
    getClient()?.clearUserIdentifier();
    userId = '';
    refresh();
  }

  function parsedAttrValue(): AttributeValue {
    if (attrType === 'number') return Number(attrValue);
    if (attrType === 'boolean') return attrValue === 'true';
    if (attrType === 'string[]') return attrValue.split(',').map((s) => s.trim());
    return attrValue;
  }
  function setAttribute(): void {
    if (attrKey.trim() === '') return;
    getClient()?.setAttribute(attrKey, parsedAttrValue());
    refresh();
  }
  function clearAttribute(): void {
    if (attrKey.trim() === '') return;
    getClient()?.clearAttribute(attrKey);
    refresh();
  }
  /** S2: `getAttribute` (singular) — declared in the catalog but never called anywhere in this sample
   *  before this fix (only the bulk `getAllAttributes()` dump was exercised). */
  function getAttribute(): void {
    if (attrKey.trim() === '') return;
    const value = getClient()?.getAttribute(attrKey);
    singleAttrDump = `getAttribute('${attrKey}') -> ${JSON.stringify(value)}`;
  }
  function clearAllAttributes(): void {
    getClient()?.clearAllAttributes();
    refresh();
  }
</script>

<h2>Settings</h2>

<div class="card">
  <h3>Identity (S2)</h3>
  <div class="row">
    <input data-testid="user-id-input" placeholder="user@bugsee.dev" bind:value={userId} />
    <button data-testid="set-user-id" onclick={setUserId}>setUserIdentifier</button>
    <button data-testid="clear-user-id" onclick={clearUserId}>clearUserIdentifier</button>
  </div>
  <p class="status-line" data-testid="current-user-id">getUserIdentifier() -&gt; {currentUserId ?? 'null'}</p>
</div>

<div class="card">
  <h3>Attributes (S2)</h3>
  <div class="row">
    <select data-testid="attr-type" bind:value={attrType}>
      <option value="string">string</option>
      <option value="number">number</option>
      <option value="boolean">boolean</option>
      <option value="string[]">string[]</option>
    </select>
    <input data-testid="attr-key" placeholder="key" bind:value={attrKey} />
    <input data-testid="attr-value" placeholder="value" bind:value={attrValue} />
    <button data-testid="set-attribute" onclick={setAttribute}>setAttribute</button>
    <button data-testid="get-attribute" onclick={getAttribute}>getAttribute</button>
    <button data-testid="clear-attribute" onclick={clearAttribute}>clearAttribute</button>
    <button data-testid="clear-all-attributes" onclick={clearAllAttributes}>clearAllAttributes</button>
  </div>
  <p class="status-line" data-testid="attrs-dump">getAllAttributes() -&gt; {attrsDump}</p>
  <p class="status-line" data-testid="single-attr-dump">{singleAttrDump}</p>
</div>

<div class="card">
  <h3>Drawer</h3>
  <button data-testid="toggle-drawer" onclick={() => (drawerOpen = !drawerOpen)}>
    {drawerOpen ? 'Close drawer' : 'Open drawer'}
  </button>
  {#if drawerOpen}
    <div class="scenario-section" data-testid="settings-drawer">
      <!--
        Replay masking targets (S11), read at WIRE depth by verify.mjs's `s11-replay-masking-wire`: the
        `s11-replay-selectors` relaunch records this drawer, and the check unzips the uploaded bundle,
        gunzips `replay.bin` and asserts which of these strings the rrweb event stream does and does not
        contain. Every literal below is therefore a NEEDLE — keep them distinctive and keep them in sync
        with the needle list in verify.mjs.

        Two of them are POSITIVE CONTROLS, and they are what make the absences mean something. Without
        them, "the secret is not in the recording" is equally true of a recording that captured nothing
        at all, which is precisely the failure mode S11 was blind to before this round.

        NOTE on `.bugsee-show` (which this field used to carry, described as an opt-out): that mark maps
        to rrweb's `unblockSelector` — it un-BLOCKS media/canvas and does nothing whatsoever for an
        input's value (packages/replay/src/masking.ts: `unblockSelector: joinSelectors(BUGSEE_SHOW, …)`,
        while inputs take `unmaskInputSelector: BUGSEE_UNMASK_INPUT`). So the field was masked exactly
        like its neighbour and the copy was wrong.

        `.bugsee-unmask` IS the input opt-out mark — but measuring it here found that it does not lift
        masking for values TYPED during a live recording either (FINDINGS.md F-4): rrweb's live input
        observer is never given `unmaskInputSelector` and masks purely off `maskInputOptions`, so the
        mark only takes effect in the FULL SNAPSHOT path, i.e. for a value already in the field when
        recording starts. The field keeps the mark because that IS the correct mark and the snapshot
        path is real; verify.mjs asserts the measured behaviour, not the documented intent.
      -->
      <p class="status-line">
        Replay masking targets (S11). Masked: the password field (sensitive floor — no option or mark can
        lift it) and <code>.s11-mask-target</code> (<code>maskTextSelector</code>). Blocked:
        <code>.s11-block-target</code> (<code>blockSelector</code>). Ignored:
        <code>.s11-ignore-target</code> (<code>ignoreSelector</code> — its input events are not recorded
        at all). Positive control, recorded in the clear: this paragraph's S11-PLAIN-TEXT-CONTROL
        marker.
      </p>
      <div class="row">
        <input
          data-testid="s11-masked-field"
          type="password"
          placeholder="PIN code (masked — sensitive floor)"
          bind:value={maskedField}
        />
        <input
          data-testid="s11-unmask-field"
          class="bugsee-unmask"
          placeholder="Marked .bugsee-unmask (snapshot-path opt-out only — F-4)"
          bind:value={shownField}
        />
        <input
          data-testid="s11-ignore-field"
          class="s11-ignore-target"
          placeholder="Ignored (ignoreSelector)"
          bind:value={ignoredField}
        />
      </div>
      <p class="status-line s11-mask-target" data-testid="s11-mask-target">
        S11-MASK-SELECTOR-TARGET-TEXT
      </p>
      <div class="s11-block-target" data-testid="s11-block-target">
        <p class="status-line">S11-BLOCK-SELECTOR-TARGET-TEXT</p>
      </div>
    </div>
  {/if}
</div>
