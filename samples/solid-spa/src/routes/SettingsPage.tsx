import { createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AttributeValue } from '@bugsee/solid';
import { getClient, SAMPLE_USER_ID } from '../bugsee';

type AttrType = 'string' | 'number' | 'boolean' | 'string[]';

function parseAttrValue(type: AttrType, raw: string): AttributeValue {
  switch (type) {
    case 'number':
      return Number(raw);
    case 'boolean':
      return raw === 'true';
    case 'string[]':
      return raw.split(',').map((s) => s.trim());
    default:
      return raw;
  }
}

/**
 * Settings page — a genuine app feature (display name, a personal-access-token field) that happens to
 * be the natural home for S2 (identity + attributes): setting a display name IS `setUserIdentifier`,
 * and a theme preference IS an attribute. The access-token field is also a masking target for S11
 * replay (`maskAllInputs`) — see scenarios.md.
 */
export default function SettingsPage(): JSX.Element {
  const client = () => getClient();
  const [userId, setUserId] = createSignal(client()?.getUserIdentifier() ?? SAMPLE_USER_ID);
  const [pat, setPat] = createSignal('');
  const [attrKey, setAttrKey] = createSignal('theme');
  const [attrType, setAttrType] = createSignal<AttrType>('string');
  const [attrValue, setAttrValue] = createSignal('dark');
  const [attrs, setAttrs] = createSignal<Record<string, AttributeValue>>(client()?.getAllAttributes() ?? {});
  const [status, setStatus] = createSignal('');

  function refreshAttrs(): void {
    setAttrs(client()?.getAllAttributes() ?? {});
  }

  return (
    <div>
      <h2>Settings</h2>

      <section class="scenario-section">
        <h3>Profile</h3>
        <p class="desc">setUserIdentifier / getUserIdentifier / clearUserIdentifier (S2)</p>
        <div class="control-row">
          <input value={userId()} onInput={(e) => setUserId(e.currentTarget.value)} data-testid="user-id-input" />
          <button
            data-testid="set-user-id"
            onClick={() => {
              client()?.setUserIdentifier(userId());
              setStatus(`user id set to "${client()?.getUserIdentifier()}"`);
            }}
          >
            Save display name
          </button>
          <button
            class="secondary"
            data-testid="clear-user-id"
            onClick={() => {
              client()?.clearUserIdentifier();
              setStatus(`user id cleared: getUserIdentifier() -> ${JSON.stringify(client()?.getUserIdentifier())}`);
            }}
          >
            Clear
          </button>
        </div>
        <div class="control-row">
          <label class="label" for="pat">
            Personal access token (masking target for replay)
          </label>
          <input
            id="pat"
            type="password"
            value={pat()}
            onInput={(e) => setPat(e.currentTarget.value)}
            placeholder="bgs_live_••••••••"
            data-testid="pat-input"
          />
        </div>
        <p class="status-line">{status()}</p>
      </section>

      <section class="scenario-section">
        <h3>Custom attributes</h3>
        <p class="desc">
          setAttribute / getAttribute / clearAttribute / clearAllAttributes / getAllAttributes, every
          AttributeValue type (string, number, boolean, string[]) (S2)
        </p>
        <div class="control-row">
          <input value={attrKey()} onInput={(e) => setAttrKey(e.currentTarget.value)} placeholder="key" data-testid="attr-key" />
          <select value={attrType()} onChange={(e) => setAttrType(e.currentTarget.value as AttrType)} data-testid="attr-type">
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
            <option value="string[]">string[]</option>
          </select>
          <input
            value={attrValue()}
            onInput={(e) => setAttrValue(e.currentTarget.value)}
            placeholder={attrType() === 'string[]' ? 'a, b, c' : 'value'}
            data-testid="attr-value"
          />
          <button
            data-testid="set-attribute"
            onClick={() => {
              const v = parseAttrValue(attrType(), attrValue());
              client()?.setAttribute(attrKey(), v);
              refreshAttrs();
              setStatus(`setAttribute(${attrKey()}, ${JSON.stringify(v)})`);
            }}
          >
            Set attribute
          </button>
        </div>
        <div class="control-row">
          <button
            class="secondary"
            data-testid="clear-attribute"
            onClick={() => {
              client()?.clearAttribute(attrKey());
              refreshAttrs();
              setStatus(`clearAttribute(${attrKey()}) -> ${JSON.stringify(client()?.getAttribute(attrKey()))}`);
            }}
          >
            Clear "{attrKey()}"
          </button>
          <button
            class="secondary"
            data-testid="clear-all-attributes"
            onClick={() => {
              client()?.clearAllAttributes();
              refreshAttrs();
              setStatus('clearAllAttributes()');
            }}
          >
            Clear all attributes
          </button>
          <button class="secondary" onClick={refreshAttrs}>
            Refresh
          </button>
        </div>
        <div class="control-row">
          <button
            class="secondary"
            data-testid="attrs-before-after-event"
            onClick={() => {
              void (async () => {
                // PLAN §4 S2: "attributes set before AND after the triggering event" — previously
                // unexercised. Sets one BEFORE the logException, and a DIFFERENT one AFTER, proving
                // both orderings work against the live client (not just "before").
                client()?.setAttribute('demoPhase', 'set-before-event');
                await client()?.logException(new Error('S2: attribute set BEFORE and AFTER this triggering event'), {
                  labels: ['s2-before-after'],
                });
                client()?.setAttribute('demoPhase', 'set-after-event');
                refreshAttrs();
                setStatus(`before+after exercised -- demoPhase now "${String(client()?.getAttribute('demoPhase'))}"`);
              })();
            }}
          >
            Set attribute BEFORE + AFTER a triggering event
          </button>
        </div>
        <pre data-testid="attrs-dump" style={{ background: '#f5f6fa', padding: '8px', 'font-size': '12px' }}>
          {JSON.stringify(attrs(), null, 2)}
        </pre>
      </section>
    </div>
  );
}
