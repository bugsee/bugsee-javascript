import { useState } from 'react';
import type { AttributeValue } from '@bugsee/react';
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
 * Settings page — a genuine app feature (display name, theme preference, a personal-access-token
 * field) that happens to be the natural home for S2 (identity + attributes): setting a display name
 * IS `setUserIdentifier`, and a theme preference IS an attribute. The access-token field is also the
 * masking target for S11 replay (`maskAllInputs`) — see scenarios.md.
 */
export default function SettingsPage(): JSX.Element {
  const client = getClient();
  const [userId, setUserId] = useState(client?.getUserIdentifier() ?? SAMPLE_USER_ID);
  const [pat, setPat] = useState('');
  const [attrKey, setAttrKey] = useState('theme');
  const [attrType, setAttrType] = useState<AttrType>('string');
  const [attrValue, setAttrValue] = useState('dark');
  const [attrs, setAttrs] = useState<Record<string, AttributeValue>>(
    () => client?.getAllAttributes() ?? {},
  );
  const [status, setStatus] = useState('');

  function refreshAttrs(): void {
    setAttrs(client?.getAllAttributes() ?? {});
  }

  return (
    <div>
      <h2>Settings</h2>

      <section className="scenario-section">
        <h3>Profile</h3>
        <p className="desc">setUserIdentifier / getUserIdentifier / clearUserIdentifier (S2)</p>
        <div className="control-row">
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            data-testid="user-id-input"
          />
          <button
            data-testid="set-user-id"
            onClick={() => {
              client?.setUserIdentifier(userId);
              setStatus(`user id set to "${client?.getUserIdentifier()}"`);
            }}
          >
            Save display name
          </button>
          <button
            className="secondary"
            data-testid="clear-user-id"
            onClick={() => {
              client?.clearUserIdentifier();
              setStatus(`user id cleared: getUserIdentifier() -> ${JSON.stringify(client?.getUserIdentifier())}`);
            }}
          >
            Clear
          </button>
        </div>
        <div className="control-row">
          <label className="label" htmlFor="pat">
            Personal access token (masking target for replay)
          </label>
          <input
            id="pat"
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="bgs_live_••••••••"
            data-testid="pat-input"
          />
        </div>
        <p className="status-line">{status}</p>
      </section>

      <section className="scenario-section">
        <h3>Custom attributes</h3>
        <p className="desc">
          setAttribute / getAttribute / clearAttribute / clearAllAttributes / getAllAttributes, every
          AttributeValue type (string, number, boolean, string[]) (S2)
        </p>
        <div className="control-row">
          <input value={attrKey} onChange={(e) => setAttrKey(e.target.value)} placeholder="key" data-testid="attr-key" />
          <select value={attrType} onChange={(e) => setAttrType(e.target.value as AttrType)} data-testid="attr-type">
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
            <option value="string[]">string[]</option>
          </select>
          <input
            value={attrValue}
            onChange={(e) => setAttrValue(e.target.value)}
            placeholder={attrType === 'string[]' ? 'a, b, c' : 'value'}
            data-testid="attr-value"
          />
          <button
            data-testid="set-attribute"
            onClick={() => {
              const v = parseAttrValue(attrType, attrValue);
              client?.setAttribute(attrKey, v);
              refreshAttrs();
              setStatus(`setAttribute(${attrKey}, ${JSON.stringify(v)})`);
            }}
          >
            Set attribute
          </button>
        </div>
        <div className="control-row">
          <button
            className="secondary"
            data-testid="clear-attribute"
            onClick={() => {
              client?.clearAttribute(attrKey);
              refreshAttrs();
              setStatus(`clearAttribute(${attrKey}) -> ${JSON.stringify(client?.getAttribute(attrKey))}`);
            }}
          >
            Clear "{attrKey}"
          </button>
          <button
            className="secondary"
            data-testid="clear-all-attributes"
            onClick={() => {
              client?.clearAllAttributes();
              refreshAttrs();
              setStatus('clearAllAttributes()');
            }}
          >
            Clear all attributes
          </button>
          <button className="secondary" onClick={refreshAttrs}>
            Refresh
          </button>
        </div>
        <pre data-testid="attrs-dump" style={{ background: '#f5f6fa', padding: 8, fontSize: 12 }}>
          {JSON.stringify(attrs, null, 2)}
        </pre>
      </section>
    </div>
  );
}
