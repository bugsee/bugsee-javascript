import type { OptionsContainer } from './contracts';

// Default OptionsContainer over a plain values map (Android OptionsContainer parity): the launch
// options bag passed to a component's start(options) so it (re)configures behavior per launch.
// Presence is decided by OWN keys (Object.hasOwn) so a key explicitly set to `undefined` is honored
// and inherited prototype members (toString, …) are never mistaken for options.
export function createOptionsContainer(values: Record<string, unknown> = {}): OptionsContainer {
  return {
    get<T>(key: string, fallback: T): T {
      return Object.hasOwn(values, key) ? (values[key] as T) : fallback;
    },
    has(key: string): boolean {
      return Object.hasOwn(values, key);
    },
  };
}
