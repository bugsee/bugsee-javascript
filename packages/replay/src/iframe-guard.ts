// @bugsee/replay — the last line of defence for blocked iframes.
//
// A blocked iframe (default `blockAllMedia`, `.bugsee-block`, `blockSelector`) must reach the recording as a
// same-size PLACEHOLDER and nothing else: its document, its text, its inputs and everything that changes inside
// it are the page's private business. The recorder (the Bugsee rrweb fork) guarantees that; this guard makes the
// guarantee independent of it. Everything the recorder emits passes through here before it is captured, and
// content that belongs to a blocked iframe is removed, whatever the recorder believed.
//
// HOW. A same-origin iframe's document never travels inside the iframe element: the recorder emits it as a
// separate mutation (`isAttachIframe`, parentId = the iframe element's id) and then reports every change inside
// it under ids of its own. So:
//   1. every iframe element node the guard sees (full snapshot, or added by a mutation) is classified BLOCKED
//      if the recorder marked it a placeholder (`rr_width`/`rr_height`) or if the block rules say so for its
//      serialized attributes (`blockSelector`/`blockClass`, unless `unblockSelector` opts it back in; a rule that
//      cannot be evaluated counts as blocked);
//   2. children of a blocked iframe node are stripped, and an attach mutation whose parent is a blocked iframe
//      is dropped; the ids of everything removed that way are remembered ("tainted");
//   3. any later event that names a tainted id (text, attribute, add, remove, input, scroll, mouse, media,
//      style, selection, pointer positions) is dropped or has the tainted entries filtered out;
//   4. the first removal is reported once (through `onViolation`): the recorder emitted something it must not.
// A full snapshot starts from a clean slate. Cost: one pass over the nodes of each snapshot/added subtree and
// set lookups per event; the sets only grow while the recorder is misbehaving.
//
// LIMITS (what this does NOT cover):
//   - it relies on rrweb's event shapes (ids, `isAttachIframe`, node trees); an event shape it does not know
//     passes through unchanged. It only ever REMOVES iframe content, it never adds or rewrites anything else;
//   - it cannot tell that a node that is not an iframe should have been blocked: that is the recorder's
//     job and has its own tests (see the real-browser masking e2e);
//   - an iframe that is blocked by a rule on an ANCESTOR (not on the iframe itself) is only recognised through
//     the recorder's placeholder marker: serialized ancestors are not consulted;
//   - cross-origin iframes are never recorded (`recordCrossOriginIframes: false`) so there is nothing to strip;
//   - a malformed event, or any error inside the guard, DROPS the event (fail closed) and is reported.
import type { eventWithTime } from '@bugsee/rrweb';

export interface IframeGuardOptions {
  /** The resolved masking `blockSelector` (media selector, `.bugsee-block`, caller selectors). */
  blockSelector: string;
  /** The resolved masking `unblockSelector` (`.bugsee-show`, caller selectors). */
  unblockSelector: string;
  /** rrweb's `blockClass` (its default, `rr-block`); absent means only the selectors decide. */
  blockClass?: string | undefined;
  /** Called once, the first time anything had to be removed or the guard failed. */
  onViolation: (error: unknown) => void;
}

/** Returns the event to capture (possibly a filtered copy), or `undefined` to drop it. */
export type IframeGuard = (event: eventWithTime) => eventWithTime | undefined;

interface SNode {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SNode[];
}

const ELEMENT_NODE = 2;
const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;

/**
 * rrweb `IncrementalSource` values that carry ONE node id as `data.id`: 2 MouseInteraction, 3 Scroll, 5 Input,
 * 7 MediaInteraction, 8 StyleSheetRule, 9 CanvasMutation, 13 StyleDeclaration, 15 AdoptedStyleSheet. (The
 * others: 0 Mutation, 1 MouseMove, 4 ViewportResize, 6 TouchMove, 10 Font, 11 Log, 12 Drag, 14 Selection,
 * 16 CustomElement.)
 */
const SINGLE_ID_SOURCES = new Set([2, 3, 5, 7, 8, 9, 13, 15]);
const POSITION_SOURCES = new Set([1, 6, 12]); // MouseMove, TouchMove, Drag
const MUTATION = 0;
const SELECTION = 14;

export function createIframeGuard(options: IframeGuardOptions): IframeGuard {
  const blockedIframes = new Set<number>();
  const tainted = new Set<number>();
  let reported = false;

  const report = (message: string): void => {
    if (reported) {
      return;
    }
    reported = true;
    try {
      options.onViolation(new Error(`replay: ${message}`));
    } catch {
      /* a throwing sink is the host's problem, never the recording's */
    }
  };

  /** Block rules against a node's serialized attributes, on a detached element (fail closed). */
  const blockedByRules = (attributes: Record<string, unknown>): boolean => {
    try {
      const probe = document.createElement('iframe');
      for (const [name, value] of Object.entries(attributes)) {
        try {
          probe.setAttribute(name, String(value));
        } catch {
          /* a name the DOM refuses cannot affect a selector */
        }
      }
      if (options.unblockSelector !== '' && probe.matches(options.unblockSelector)) {
        return false;
      }
      if (options.blockClass !== undefined && probe.classList.contains(options.blockClass)) {
        return true;
      }
      return options.blockSelector !== '' && probe.matches(options.blockSelector);
    } catch {
      return true;
    }
  };

  const isBlockedIframe = (node: SNode): boolean => {
    const attributes = node.attributes ?? {};
    return 'rr_width' in attributes || 'rr_height' in attributes || blockedByRules(attributes);
  };

  const taint = (node: SNode): void => {
    tainted.add(node.id);
    for (const child of node.childNodes ?? []) {
      taint(child);
    }
  };

  /** Strip the children of every blocked iframe in this subtree. */
  const scan = (node: SNode): void => {
    if (node.type === ELEMENT_NODE && node.tagName === 'iframe') {
      if (isBlockedIframe(node)) {
        blockedIframes.add(node.id);
        if (node.childNodes !== undefined && node.childNodes.length > 0) {
          report('content of a blocked iframe reached the recorder output and was removed');
          for (const child of node.childNodes) {
            taint(child);
          }
          node.childNodes = [];
        }
        return;
      }
    }
    for (const child of node.childNodes ?? []) {
      scan(child);
    }
  };

  const isTainted = (id: unknown): boolean => typeof id === 'number' && tainted.has(id);

  interface Mut {
    adds?: Array<{ parentId: number; node: SNode }>;
    texts?: Array<{ id: number }>;
    attributes?: Array<{ id: number }>;
    removes?: Array<{ parentId: number; id: number }>;
  }

  const guardMutation = (event: eventWithTime, data: Mut): eventWithTime | undefined => {
    const adds = Array.isArray(data.adds) ? data.adds : [];
    const texts = Array.isArray(data.texts) ? data.texts : [];
    const attributes = Array.isArray(data.attributes) ? data.attributes : [];
    const removes = Array.isArray(data.removes) ? data.removes : [];
    let changed = false;
    const keptAdds = adds.filter((add) => {
      if (blockedIframes.has(add.parentId) || tainted.has(add.parentId)) {
        report('a document was attached to a blocked iframe and was removed');
        taint(add.node);
        changed = true;
        return false;
      }
      scan(add.node);
      return true;
    });
    const keptTexts = texts.filter((t) => !isTainted(t.id));
    const keptAttributes = attributes.filter((a) => !isTainted(a.id));
    const keptRemoves = removes.filter((r) => !isTainted(r.id) && !isTainted(r.parentId));
    changed =
      changed ||
      keptTexts.length !== texts.length ||
      keptAttributes.length !== attributes.length ||
      keptRemoves.length !== removes.length;
    if (!changed) {
      return event;
    }
    if (keptAdds.length + keptTexts.length + keptAttributes.length + keptRemoves.length === 0) {
      return undefined;
    }
    return {
      ...event,
      data: {
        ...(event as unknown as { data: object }).data,
        adds: keptAdds,
        texts: keptTexts,
        attributes: keptAttributes,
        removes: keptRemoves,
      },
    } as unknown as eventWithTime;
  };

  const process = (event: eventWithTime): eventWithTime | undefined => {
    const raw = event as unknown as { type: number; data: Record<string, unknown> };
    if (raw.type === FULL_SNAPSHOT) {
      blockedIframes.clear();
      tainted.clear();
      const node = (raw.data as { node?: SNode } | null | undefined)?.node;
      if (typeof node === 'object' && node !== null) {
        scan(node);
      }
      return event;
    }
    if (raw.type !== INCREMENTAL_SNAPSHOT) {
      return event;
    }
    const data = raw.data;
    if (typeof data !== 'object' || data === null) {
      return event; // nothing a blocked iframe could be in
    }
    const source = data.source as number;
    if (source === MUTATION) {
      return guardMutation(event, data as Mut);
    }
    if (SINGLE_ID_SOURCES.has(source)) {
      if (isTainted(data.id)) {
        report('an event from inside a blocked iframe was removed');
        return undefined;
      }
      return event;
    }
    if (POSITION_SOURCES.has(source)) {
      const positions = data.positions as Array<{ id: number }> | undefined;
      if (!Array.isArray(positions)) {
        return event;
      }
      const kept = positions.filter((p) => !isTainted(p.id));
      if (kept.length === positions.length) {
        return event;
      }
      report('an event from inside a blocked iframe was removed');
      return kept.length === 0
        ? undefined
        : ({ ...raw, data: { ...data, positions: kept } } as unknown as eventWithTime);
    }
    if (source === SELECTION) {
      const ranges = data.ranges as Array<{ start: number; end: number }> | undefined;
      if (Array.isArray(ranges) && ranges.some((r) => isTainted(r.start) || isTainted(r.end))) {
        report('an event from inside a blocked iframe was removed');
        return undefined;
      }
    }
    return event;
  };

  return (event) => {
    try {
      return process(event);
    } catch (error) {
      report(`the blocked-iframe guard failed and dropped an event (${String(error)})`);
      return undefined;
    }
  };
}
