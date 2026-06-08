import { CaptureDataEntryBase, type ReportSnapshotSource } from '@bugsee/core';
import { describeTarget } from './input-source';

// Browser VIEW HIERARCHY (Android viewtree parity). A DOM-tree snapshot taken AT REPORT TIME (the
// browser analog of mobile's at-report screenshot) — NOT a continuous ring stream (serializing the whole
// DOM every tick is too heavy) and NOT part of capture-recovery (a next-launch DOM is not the incident's).
// Each node reuses the reviewed `describeTarget` for its PII-safe descriptor (tag/id/class/type/text,
// masking password + `[data-bugsee-hidden]` subtrees to {tag, masked}) plus its layout rect; a masked
// subtree collapses to a single node (no children/text). The walk is bounded (maxNodes/maxDepth) and
// per-node throw-isolated so one exotic element (a web component, instrumented DOM) can't lose the tree.

/** A node in the captured view hierarchy. */
export interface ViewNode {
  tag: string;
  id?: string;
  class?: string;
  type?: string;
  text?: string;
  masked?: boolean;
  /** Layout box from getBoundingClientRect, rounded to integers. */
  rect?: { x: number; y: number; width: number; height: number };
  children?: ViewNode[];
}

interface SnapshotElement {
  tagName?: unknown;
  children?: ArrayLike<unknown>;
  getBoundingClientRect?: () => { x: number; y: number; width: number; height: number };
}

interface DocumentLike {
  body?: SnapshotElement | null;
  documentElement?: SnapshotElement | null;
}

/** Injected configuration (defaults to the global document + the canonical mask attribute + bounds). */
export interface DomSnapshotEnv {
  /** The document to snapshot. Default the global `document` (resolved at snapshot time). */
  document?: DocumentLike;
  /** Elements (or subtrees) to fully mask. Default `[data-bugsee-hidden]`. */
  maskSelector?: string;
  /** Max nodes captured (bounds snapshot size on large DOMs). Default 2000. */
  maxNodes?: number;
  /** Max tree depth captured. Default 32. */
  maxDepth?: number;
}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const DEFAULT_MAX_NODES = 2000;
const DEFAULT_MAX_DEPTH = 32;

const readRect = (el: SnapshotElement): ViewNode['rect'] => {
  if (typeof el.getBoundingClientRect !== 'function') return undefined;
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
};

// describeTarget gives {tag, id?, class?, type?, text?, selector?, masked?}; build a ViewNode from it
// (dropping the flat-event `selector`, adding the layout rect). Returns undefined for a non-element.
const buildNode = (el: SnapshotElement, mask: string): ViewNode | undefined => {
  const desc = describeTarget(el, mask);
  if (desc.tag === undefined) return undefined;
  const node: ViewNode = { tag: desc.tag };
  if (desc.id !== undefined) node.id = desc.id;
  if (desc.class !== undefined) node.class = desc.class;
  if (desc.type !== undefined) node.type = desc.type;
  if (desc.text !== undefined) node.text = desc.text;
  if (desc.masked === true) node.masked = true;
  const rect = readRect(el);
  if (rect !== undefined) node.rect = rect;
  return node;
};

const resolveDocument = (env: DomSnapshotEnv): DocumentLike | undefined =>
  env.document ?? (typeof document !== 'undefined' ? (document as DocumentLike) : undefined);

/** Build a DOM view-hierarchy snapshotter (defaults to the global document). */
export function createDomSnapshot(env: DomSnapshotEnv = {}): () => ViewNode | undefined {
  const mask = env.maskSelector ?? '[data-bugsee-hidden]';
  const maxNodes = env.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = env.maxDepth ?? DEFAULT_MAX_DEPTH;

  return () => {
    const doc = resolveDocument(env);
    const root = doc?.body ?? doc?.documentElement ?? undefined;
    if (!root) return undefined;

    const budget = { left: maxNodes };
    const walk = (el: SnapshotElement, depth: number): ViewNode | undefined => {
      if (budget.left <= 0 || depth > maxDepth) return undefined;
      let node: ViewNode | undefined;
      try {
        node = buildNode(el, mask);
      } catch {
        return undefined; // exotic/instrumented node → skip, keep the rest of the tree
      }
      if (node === undefined) return undefined;
      budget.left -= 1;
      if (node.masked === true) return node; // a masked subtree collapses to one node
      const children: ViewNode[] = [];
      for (const child of Array.from(el.children ?? []) as SnapshotElement[]) {
        const tag = typeof child.tagName === 'string' ? child.tagName.toLowerCase() : undefined;
        if (tag !== undefined && SKIP_TAGS.has(tag)) continue;
        const childNode = walk(child, depth + 1);
        if (childNode !== undefined) children.push(childNode);
      }
      if (children.length > 0) node.children = children;
      return node;
    };

    return walk(root, 0);
  };
}

/**
 * A {@link ReportSnapshotSource} that captures the DOM view hierarchy at report time → a single
 * `viewtree` entry (or none when there is no DOM). Wire it into the client's `reportSnapshots`.
 */
export function createViewtreeSnapshotSource(env?: DomSnapshotEnv): ReportSnapshotSource {
  const snapshot = createDomSnapshot(env);
  return (now: number) => {
    const tree = snapshot();
    return tree !== undefined ? [new CaptureDataEntryBase('viewtree', now, tree)] : [];
  };
}
