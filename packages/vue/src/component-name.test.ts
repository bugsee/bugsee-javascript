import { describe, expect, it } from 'vitest';
import { vueComponentName } from './component-name';

// The shared Vue component-name resolver — single source of truth for BOTH the error labels (error.ts) and
// the component attribution mixin (component-annotate.ts), so the two can never drift to different names for
// the same component. Mirrors Vue's own `getComponentName` precedence.
describe('vueComponentName', () => {
  it('prefers $options.name (options API) over every fallback', () => {
    expect(
      vueComponentName({ $options: { name: 'UserCard' }, $: { type: { name: 'X', __name: 'Y' } } }),
    ).toBe('UserCard');
  });

  it('falls back to $.type.name (resolved component) when $options.name is absent', () => {
    expect(vueComponentName({ $: { type: { name: 'Profile' } } })).toBe('Profile');
  });

  it('falls back to $.type.displayName (functional component) when name is absent', () => {
    expect(vueComponentName({ $: { type: { displayName: 'Avatar' } } })).toBe('Avatar');
  });

  it('ranks $.type.name and $options.name ABOVE displayName (displayName is only a fallback)', () => {
    // pins displayName's position below both explicit names — a reorder must be caught.
    expect(vueComponentName({ $: { type: { name: 'Real', displayName: 'Func' } } })).toBe('Real');
    expect(
      vueComponentName({ $options: { name: 'Opt' }, $: { type: { displayName: 'Func' } } }),
    ).toBe('Opt');
  });

  it('ranks displayName ABOVE __name (the inferred name is the last resort)', () => {
    expect(vueComponentName({ $: { type: { displayName: 'Func', __name: 'Inferred' } } })).toBe(
      'Func',
    );
  });

  it('falls back to $.type.__name (<script setup>-inferred) as the last resort', () => {
    expect(vueComponentName({ $: { type: { __name: 'Dashboard' } } })).toBe('Dashboard');
  });

  it('returns undefined for a null / non-object instance', () => {
    expect(vueComponentName(null)).toBeUndefined();
    expect(vueComponentName(undefined)).toBeUndefined();
    expect(vueComponentName(42)).toBeUndefined();
  });

  it('returns undefined for a nameless instance', () => {
    expect(vueComponentName({ $options: {} })).toBeUndefined();
    expect(vueComponentName({})).toBeUndefined();
  });

  it('returns undefined when the resolved name is an empty string or a non-string', () => {
    expect(vueComponentName({ $options: { name: '' } })).toBeUndefined();
    expect(vueComponentName({ $options: { name: 123 } })).toBeUndefined();
  });
});
