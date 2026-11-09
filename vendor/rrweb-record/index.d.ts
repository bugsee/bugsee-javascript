import type { recordOptions } from 'rrweb';
import type { eventWithTime, listenerHandler } from '@rrweb/types';

/**
 * Bugsee-hardened rrweb record function (record path only; the replay player is tree-shaken out).
 * Adds `maskAttributeFn` to the standard record options for fail-closed attribute-value masking.
 */
export declare function record<T = eventWithTime>(
  options?: recordOptions<T> & {
    maskAttributeFn?: (key: string, value: string, element: HTMLElement) => string;
  },
): listenerHandler | undefined;
