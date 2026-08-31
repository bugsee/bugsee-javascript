import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AttributeValue } from '@bugsee/angular';
import { SAMPLE_USER_ID, getClient } from '../bugsee';

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
 * and the PAT field is also the masking target for S11 replay (`maskAllInputs`).
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './settings.component.html',
})
export class SettingsComponent {
  // A method, not a cached field: getClient() must be re-resolved on each call in case the SDK has
  // been relaunched onto a new client instance elsewhere in the app (see scenario-panel.component.ts's
  // identical fix for why a cached readonly field silently breaks after a relaunch).
  #client() {
    return getClient();
  }

  userId = this.#client()?.getUserIdentifier() ?? SAMPLE_USER_ID;
  pat = '';
  attrKey = 'theme';
  attrType: AttrType = 'string';
  attrValue = 'dark';
  readonly attrs = signal<Record<string, AttributeValue>>(this.#client()?.getAllAttributes() ?? {});
  readonly status = signal('');

  refreshAttrs(): void {
    this.attrs.set(this.#client()?.getAllAttributes() ?? {});
  }

  setUserId(): void {
    this.#client()?.setUserIdentifier(this.userId);
    this.status.set(`user id set to "${this.#client()?.getUserIdentifier()}"`);
  }

  clearUserId(): void {
    this.#client()?.clearUserIdentifier();
    this.status.set(`user id cleared: getUserIdentifier() -> ${JSON.stringify(this.#client()?.getUserIdentifier())}`);
  }

  setAttribute(): void {
    const v = parseAttrValue(this.attrType, this.attrValue);
    this.#client()?.setAttribute(this.attrKey, v);
    this.refreshAttrs();
    this.status.set(`setAttribute(${this.attrKey}, ${JSON.stringify(v)})`);
  }

  clearAttribute(): void {
    this.#client()?.clearAttribute(this.attrKey);
    this.refreshAttrs();
    this.status.set(`clearAttribute(${this.attrKey}) -> ${JSON.stringify(this.#client()?.getAttribute(this.attrKey))}`);
  }

  clearAllAttributes(): void {
    this.#client()?.clearAllAttributes();
    this.refreshAttrs();
    this.status.set('clearAllAttributes()');
  }

  attrsJson(): string {
    return JSON.stringify(this.attrs(), null, 2);
  }
}
