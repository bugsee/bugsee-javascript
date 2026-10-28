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
//   3b. an iframe that is recorded and then BECOMES blocked (an attribute mutation: a class, `rr_width`, ...) is
//      reclassified on its merged attributes; everything attached under it (nested iframes included) is tainted
//      from then on. The recorder announces it: when an attached iframe becomes blocked it emits a placeholder
//      marker (`rr_width`/`rr_height`) on the iframe, which is what reaches this guard (rrweb drops the class change
//      itself, because the iframe is blocked by then);
//   4. the first removal is reported once (through `onViolation`): the recorder emitted something it must not. The
//      recorder's marker on an already-gated nested iframe is removed silently, so it cannot use that one report up.
// A full snapshot starts from a clean slate. Cost: one pass over the nodes of each snapshot/added subtree and
// set lookups per event. Memory: the guard remembers the attributes of each recorded iframe and the ids of the
// nodes attached under it, and forgets removed subtrees, so it holds what those iframes hold now; the tainted
// set only grows while the recorder is misbehaving. One gap is accepted: the ancestors of an iframe that was added
// AFTER the snapshot arrive as separate flat `adds` entries and are not tracked, so removing such a container does
// not forget the iframe's entries; they are released by the next full snapshot (the recorder takes one every
// `checkoutEveryNms`, 60 s by default), which bounds them by the churn of one checkout window.
//
// LIMITS (what this does NOT cover):
//   - it reads rrweb's event shapes (ids, `isAttachIframe`, node trees). An event it cannot read (a snapshot
//     without a node tree, a mutation without its four lists, an id-carrying event without a numeric id, ...) is
//     DROPPED and reported, as is anything that makes the guard itself throw; events that carry no node at all
//     (meta, custom, viewport, log) pass. It only ever REMOVES iframe content, it never rewrites anything else;
//   - Font (10) and CustomElement (16) events name no node, so the guard cannot attribute them to an iframe: for
//     those the recorder's own emit-time gate is the only protection;
//   - an iframe that is blocked by a rule on an ANCESTOR is recognised through the recorder's placeholder marker
//     (rr_width/rr_height, emitted when an attached iframe or a container of it becomes blocked), never through
//     the serialized ancestors. Against a recorder that does not emit that marker (the previous pins) the guard
//     only protects iframes that were blocked from the start;
//   - the caller's `unblockSelector` is tested against a DETACHED copy of the iframe (built from its serialized
//     attributes), so a contextual selector (`#trusted iframe`, `.x > iframe`, `:first-child`, ...) can never match:
//     the recorder records such an iframe, the guard removes its document and reports a violation. Value selectors
//     (`iframe[data-embed="x"]`, `.bugsee-show`) are unaffected. See bugsee-javascript#123;
//   - a blocked iframe is never reopened by the guard: once it is blocked, whatever it attaches stays dropped (and is
//     reported) until the next full snapshot. The recorder drops the change that blocks an iframe, and every
//     attribute change while `iframe` is in `blockSelector` (the default), and emits only the placeholder marker, so
//     the guard cannot see an unblock, nor tell an iframe's own block from an ancestor's. An iframe that is blocked,
//     unblocked and navigated therefore still produces one (false) report. That needs an "unblocked" signal from the
//     fork; see bugsee-javascript#124;
//   - it cannot tell that a node that is not an iframe should have been blocked: that is the recorder's job and
//     has its own tests (see the real-browser masking e2e);
//   - cross-origin iframes are never recorded (`recordCrossOriginIframes: false`) so there is nothing to strip.
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

/**
 * Returns the event to capture (possibly a filtered copy), or `undefined` to drop it. `tracked()` is the number of
 * entries the guard currently remembers about recorded iframes (a diagnostic, and the memory-bound test seam).
 */
export interface IframeGuard {
  (event: eventWithTime): eventWithTime | undefined;
  tracked(): number;
}

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
const STYLE_SHEET_RULE = 8;
const STYLE_DECLARATION = 13;
const SELECTION = 14;
const ADOPTED_STYLE_SHEET = 15;

/** The style sheet ids an adopted-style-sheet event names (`styleIds`, and the `styles` it defines). */
function styleIdsOf(data: Record<string, unknown>): number[] {
  const ids: number[] = [];
  if (Array.isArray(data.styleIds)) {
    for (const id of data.styleIds) {
      if (typeof id === 'number') ids.push(id);
    }
  }
  if (Array.isArray(data.styles)) {
    for (const style of data.styles as Array<{ styleId?: unknown }>) {
      if (typeof style?.styleId === 'number') ids.push(style.styleId);
    }
  }
  return ids;
}

export function createIframeGuard(options: IframeGuardOptions): IframeGuard {
  const blockedIframes = new Set<number>();
  const tainted = new Set<number>();
  // Iframes that are recorded (not blocked) as of now, with their current attributes, and the iframe each node of
  // their attached documents belongs to. They exist so that an iframe that BECOMES blocked (an attribute
  // mutation) can be recognised, and everything recorded under it from then on removed.
  const openIframes = new Map<number, Record<string, unknown>>();
  const ownerOf = new Map<number, number>();
  // The children of every owned node (and of each open iframe), so that a removed subtree can be forgotten:
  // the maps then hold what the recorded iframes hold NOW, not everything they ever held.
  const kidsOf = new Map<number, Set<number>>();
  // The current parent of every owned node: a node that is MOVED (re-added under another parent without a
  // removal) must leave its old parent's children, or removing the old parent would forget it.
  const parentOf = new Map<number, number>();
  // Adopted style sheets: the iframe each belongs to (so a later block taints it), and the tainted ones. A style
  // sheet event for an adopted sheet names it by `styleId` only.
  const styleOwner = new Map<number, number>();
  const taintedStyles = new Set<number>();
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

  /** Take `id` out of its parent's children. */
  const detach = (id: number, parentId: number): void => {
    const siblings = kidsOf.get(parentId);
    if (siblings?.delete(id) && siblings.size === 0) {
      kidsOf.delete(parentId);
    }
  };

  /** Remember that `node` and everything under it lives in the document attached to the open iframe `owner`. */
  const own = (node: SNode, owner: number, parentId: number): void => {
    ownerOf.set(node.id, owner);
    link(node.id, parentId);
    for (const child of node.childNodes ?? []) {
      own(child, owner, node.id);
    }
  };

  /** Forget a removed node, everything under it, and any open iframe among them. */
  const forget = (id: number, parentId: number): void => {
    detach(id, parentOf.get(id) ?? parentId);
    const stack = [id];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      ownerOf.delete(next);
      parentOf.delete(next);
      openIframes.delete(next);
      for (const kid of kidsOf.get(next) ?? []) {
        stack.push(kid);
      }
      kidsOf.delete(next);
    }
  };

  /** Whether `owner`, or something it is nested in, is the iframe `id`. */
  const within = (owner: number | undefined, id: number): boolean => {
    let current = owner;
    while (current !== undefined && current !== id) {
      current = ownerOf.get(current);
    }
    return current === id;
  };

  /** An open iframe turned out to be blocked: everything recorded under it (nested iframes included) is tainted. */
  const closeIframe = (id: number): void => {
    openIframes.delete(id);
    blockedIframes.add(id);
    for (const [nodeId, owner] of ownerOf) {
      if (within(owner, id)) {
        tainted.add(nodeId);
      }
    }
    for (const [styleId, owner] of styleOwner) {
      if (within(owner, id)) {
        taintedStyles.add(styleId);
      }
    }
  };

  const taint = (node: SNode): void => {
    tainted.add(node.id);
    for (const child of node.childNodes ?? []) {
      taint(child);
    }
  };

  /** Record `id` as a child of `parentId`, so that removing the parent can forget it. */
  const link = (id: number, parentId: number): void => {
    const previous = parentOf.get(id);
    if (previous !== undefined && previous !== parentId) {
      detach(id, previous);
    }
    parentOf.set(id, parentId);
    let kids = kidsOf.get(parentId);
    if (kids === undefined) {
      kids = new Set();
      kidsOf.set(parentId, kids);
    }
    kids.add(id);
  };

  /**
   * Strip the children of every blocked iframe in this subtree, and register every open iframe. Returns whether
   * the subtree holds an open iframe; the nodes on the way to one are linked to their parents (and only those),
   * so that removing a container of an open iframe forgets the iframe and what is attached under it.
   */
  const scan = (node: SNode, parentId: number | undefined): boolean => {
    let holdsOpenIframe = false;
    if (node.type === ELEMENT_NODE && node.tagName === 'iframe') {
      if (isBlockedIframe(node)) {
        blockedIframes.add(node.id);
        if (node.childNodes !== undefined && node.childNodes.length > 0) {
          for (const child of node.childNodes) {
            taint(child);
          }
          node.childNodes = [];
          report('content of a blocked iframe reached the recorder output and was removed');
        }
        return false;
      }
      openIframes.set(node.id, { ...(node.attributes ?? {}) });
      holdsOpenIframe = true;
    }
    for (const child of node.childNodes ?? []) {
      holdsOpenIframe = scan(child, node.id) || holdsOpenIframe;
    }
    if (holdsOpenIframe && parentId !== undefined) {
      link(node.id, parentId);
    }
    return holdsOpenIframe;
  };

  const taintStyles = (data: Record<string, unknown>): void => {
    for (const styleId of styleIdsOf(data)) {
      taintedStyles.add(styleId);
    }
  };

  const isTainted = (id: unknown): boolean => typeof id === 'number' && tainted.has(id);

  const mergeAttributes = (
    current: Record<string, unknown>,
    changes: Record<string, unknown> | undefined,
  ): Record<string, unknown> => {
    const merged = { ...current };
    for (const [name, value] of Object.entries(changes ?? {})) {
      if (value === null || value === undefined) {
        delete merged[name];
      } else {
        merged[name] = value;
      }
    }
    return merged;
  };

  /** Apply an attribute mutation to an open iframe; a rrweb `null` value removes the attribute. */
  const reclassify = (
    id: number,
    current: Record<string, unknown>,
    changes: Record<string, unknown> | undefined,
  ): void => {
    const merged = mergeAttributes(current, changes);
    if (isBlockedIframe({ id, type: ELEMENT_NODE, attributes: merged })) {
      // Not a violation by itself: the recorder says so with a placeholder marker when an app blocks an iframe.
      // Whatever still comes out of it afterwards is removed (and reported) below.
      closeIframe(id);
    } else {
      openIframes.set(id, merged);
    }
  };

  const isMarkerOnly = (attrs: Record<string, unknown> | undefined): boolean => {
    const names = Object.keys(attrs ?? {});
    return names.length > 0 && names.every((n) => n === 'rr_width' || n === 'rr_height');
  };

  interface Mut {
    adds?: Array<{ parentId: number; node: SNode }>;
    texts?: Array<{ id: number }>;
    attributes?: Array<{ id: number; attributes?: Record<string, unknown> }>;
    removes?: Array<{ parentId: number; id: number }>;
  }

  const guardMutation = (event: eventWithTime, data: Mut): eventWithTime | undefined => {
    const { adds, texts, attributes, removes } = data;
    if (
      !Array.isArray(adds) ||
      !Array.isArray(texts) ||
      !Array.isArray(attributes) ||
      !Array.isArray(removes)
    ) {
      return malformed('a mutation event without its adds/texts/attributes/removes lists');
    }
    let changed = false;
    let violation = false;
    // rrweb applies removals first: forget removed subtrees before anything is (re)added under them.
    for (const removal of removes) {
      forget(removal.id, removal.parentId);
    }
    // An attribute change that blocks an open iframe comes first, so an attach in the SAME event is dropped.
    for (const entry of attributes) {
      const current = openIframes.get(entry.id);
      if (current !== undefined) {
        reclassify(entry.id, current, entry.attributes);
      }
    }
    const keptAdds = adds.filter((add) => {
      if (blockedIframes.has(add.parentId) || tainted.has(add.parentId)) {
        taint(add.node);
        changed = true;
        violation = true;
        return false;
      }
      scan(add.node, add.parentId);
      const owner = openIframes.has(add.parentId) ? add.parentId : ownerOf.get(add.parentId);
      if (owner !== undefined) {
        own(add.node, owner, add.parentId);
      }
      return true;
    });
    const keptTexts = texts.filter((t) => !isTainted(t.id));
    const keptAttributes = attributes.filter((a) => !isTainted(a.id));
    // The recorder's own placeholder marker on an iframe whose document is already gated (a nested iframe after its
    // outer frame was blocked) carries no content: it is removed, not reported.
    const contentRemoved =
      keptTexts.length !== texts.length ||
      attributes.some(
        (a) =>
          isTainted(a.id) && !(blockedIframes.has(a.id as number) && isMarkerOnly(a.attributes)),
      );
    if (violation) {
      report('a document was attached to a blocked iframe and was removed');
    } else if (contentRemoved) {
      // (a removal of a node of a blocked iframe is legitimate, the app may tear it down: not reported)
      report('a mutation from inside a blocked iframe was removed');
    }
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

  const malformed = (what: string): undefined => {
    report(`the blocked-iframe guard dropped a malformed event (${what})`);
    return undefined;
  };

  const process = (event: eventWithTime): eventWithTime | undefined => {
    const raw = event as unknown as { type: number; data: Record<string, unknown> };
    if (raw.type === FULL_SNAPSHOT) {
      const node = (raw.data as { node?: SNode } | null | undefined)?.node;
      if (typeof node !== 'object' || node === null) {
        return malformed('a full snapshot without a node tree');
      }
      blockedIframes.clear();
      tainted.clear();
      openIframes.clear();
      ownerOf.clear();
      kidsOf.clear();
      parentOf.clear();
      styleOwner.clear();
      taintedStyles.clear();
      scan(node, undefined);
      return event;
    }
    if (raw.type !== INCREMENTAL_SNAPSHOT) {
      return event;
    }
    const data = raw.data;
    if (typeof data !== 'object' || data === null) {
      return malformed('an incremental event without data');
    }
    const source = data.source as number;
    if (source === MUTATION) {
      return guardMutation(event, data as Mut);
    }
    if (SINGLE_ID_SOURCES.has(source)) {
      const id = data.id;
      if (source === STYLE_SHEET_RULE || source === STYLE_DECLARATION) {
        // adopted sheets are named by `styleId` alone; a sheet that belongs to a document has `id` instead
        if (typeof data.styleId === 'number' && taintedStyles.has(data.styleId)) {
          report('a style event from inside a blocked iframe was removed');
          return undefined;
        }
        if (id === undefined && typeof data.styleId === 'number') {
          return event;
        }
      }
      if (typeof id !== 'number') {
        return malformed(`an event of source ${source} without a node id`);
      }
      if (isTainted(id)) {
        if (source === ADOPTED_STYLE_SHEET) {
          taintStyles(data);
        }
        report('an event from inside a blocked iframe was removed');
        return undefined;
      }
      if (source === ADOPTED_STYLE_SHEET) {
        const owner = openIframes.has(id) ? id : ownerOf.get(id);
        if (owner !== undefined) {
          for (const styleId of styleIdsOf(data)) {
            styleOwner.set(styleId, owner);
          }
        }
      }
      return event;
    }
    if (POSITION_SOURCES.has(source)) {
      const positions = data.positions as Array<{ id: number }> | undefined;
      if (!Array.isArray(positions)) {
        return malformed(`an event of source ${source} without positions`);
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
      if (!Array.isArray(ranges)) {
        return malformed('a selection event without ranges');
      }
      if (ranges.some((r) => isTainted(r.start) || isTainted(r.end))) {
        report('an event from inside a blocked iframe was removed');
        return undefined;
      }
    }
    return event;
  };

  const guard = (event: eventWithTime): eventWithTime | undefined => {
    try {
      return process(event);
    } catch (error) {
      report(`the blocked-iframe guard failed and dropped an event (${String(error)})`);
      return undefined;
    }
  };
  guard.tracked = (): number =>
    openIframes.size +
    ownerOf.size +
    kidsOf.size +
    parentOf.size +
    styleOwner.size +
    taintedStyles.size;
  return guard;
}
