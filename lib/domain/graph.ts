import { shortTypeId } from "./normalizer";
import type {
  GraphEdge, GraphNode, NormalizedContentType, NormalizedItem, ReferenceGraph, SchemaField,
} from "./types";

export interface RawRef {
  kind: "item" | "asset";
  contentTypeUid?: string;
  uid: string;
  assetName?: string;
  field: string;
  via: GraphEdge["via"];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Walk a schema against projected item values and collect every outgoing reference: content links /
 * references (`{ contentType, id }`) and image / video links (`{ id, name }`).
 * `typeOf` maps a content type schema URI to its short id.
 */
export function extractRefs(schema: SchemaField[], values: Obj, typeOf: (schemaUri: string) => string = shortTypeId): RawRef[] {
  const out: RawRef[] = [];
  const visit = (fields: SchemaField[], data: Obj, prefix: string) => {
    for (const f of fields) {
      const value = data?.[f.uid];
      const path = prefix ? `${prefix}.${f.uid}` : f.uid;
      if (value === undefined || value === null) continue;
      switch (f.dataType) {
        case "reference": {
          ([] as unknown[]).concat(value).forEach((item, i) => {
            if (!isObj(item) || typeof item.id !== "string") return;
            const ct = typeof item.contentType === "string" ? typeOf(item.contentType) : f.referenceTo?.[0];
            out.push({ kind: "item", uid: item.id, contentTypeUid: ct, field: f.multiple ? `${path}[${i}]` : path, via: "reference" });
          });
          break;
        }
        case "image":
        case "video": {
          ([] as unknown[]).concat(value).forEach((item, i) => {
            if (isObj(item) && typeof item.id === "string") out.push({ kind: "asset", uid: item.id, assetName: typeof item.name === "string" ? item.name : undefined, field: f.multiple ? `${path}[${i}]` : path, via: "asset" });
          });
          break;
        }
        case "object":
          ([] as unknown[]).concat(value).forEach((item, i) => {
            if (isObj(item)) visit(f.schema ?? [], item, f.multiple ? `${path}[${i}]` : path);
          });
          break;
        default:
          break;
      }
    }
  };
  visit(schema, values, "");
  return out;
}

export function buildGraph(opts: {
  contentTypes: NormalizedContentType[];
  entries: NormalizedItem[];
  /** Content types whose entries were fully listed (existence of targets is knowable). */
  completeTypes: Set<string>;
}): ReferenceGraph {
  const ctTitle = new Map(opts.contentTypes.map((c) => [c.uid, c.title]));
  const bySchema = new Map(opts.contentTypes.filter((c) => c.schemaId).map((c) => [c.schemaId as string, c.uid]));
  const typeOf = (uri: string) => bySchema.get(uri) ?? shortTypeId(uri);
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const entryIds = new Set(opts.entries.map((e) => `${e.contentTypeUid}/${e.uid}`));

  for (const e of opts.entries) {
    nodes.set(`${e.contentTypeUid}/${e.uid}`, {
      id: `${e.contentTypeUid}/${e.uid}`, kind: "item", contentTypeUid: e.contentTypeUid, contentTypeTitle: ctTitle.get(e.contentTypeUid) ?? e.contentTypeUid, uid: e.uid, title: e.title,
    });
  }

  for (const e of opts.entries) {
    const ct = opts.contentTypes.find((c) => c.uid === e.contentTypeUid);
    if (!ct) continue;
    const from = `${e.contentTypeUid}/${e.uid}`;
    for (const r of extractRefs(ct.schema, e.values, typeOf)) {
      let to: string;
      if (r.kind === "asset") {
        to = `asset/${r.uid}`;
        if (!nodes.has(to)) nodes.set(to, { id: to, kind: "asset", uid: r.uid, title: r.assetName ?? r.uid });
        else if (r.assetName && nodes.get(to)!.title === r.uid) nodes.get(to)!.title = r.assetName;
      } else {
        // Resolve by id among scanned items first (a link may name a type the item no longer has).
        const resolved = r.contentTypeUid && entryIds.has(`${r.contentTypeUid}/${r.uid}`)
          ? `${r.contentTypeUid}/${r.uid}`
          : [...entryIds].find((id) => id.endsWith(`/${r.uid}`));
        to = resolved ?? `${r.contentTypeUid ?? "unknown"}/${r.uid}`;
        if (!nodes.has(to)) {
          const known = Boolean(r.contentTypeUid && opts.completeTypes.has(r.contentTypeUid));
          nodes.set(to, {
            id: to, kind: known ? "missing" : "item", contentTypeUid: r.contentTypeUid, contentTypeTitle: r.contentTypeUid ? ctTitle.get(r.contentTypeUid) ?? r.contentTypeUid : undefined,
            uid: r.uid, title: known ? `Missing content item ${r.uid}` : r.uid, unscanned: !known,
          });
        }
      }
      const id = `${from}->${to}#${r.field}`;
      if (from !== to) edges.set(id, { id, from, to, field: r.field, via: r.via });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ---------- Analysis ----------

export interface Adjacency {
  out: Map<string, GraphEdge[]>;
  inc: Map<string, GraphEdge[]>;
}

export function adjacency(g: ReferenceGraph): Adjacency {
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    inc.set(e.to, [...(inc.get(e.to) ?? []), e]);
  }
  return { out, inc };
}

/**
 * Blast radius: every node that (transitively) references `id`, i.e. what could be affected by editing it.
 * Returns node id -> shortest depth (1 = direct dependent). Cycle-safe; `id` itself is excluded.
 */
export function dependents(adj: Adjacency, id: string, maxDepth = 6): Map<string, number> {
  const depth = new Map<string, number>();
  let frontier = [id];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const e of adj.inc.get(n) ?? []) {
        if (e.from === id || depth.has(e.from)) continue;
        depth.set(e.from, d);
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return depth;
}

/** Everything `id` (transitively) depends on. */
export function dependencies(adj: Adjacency, id: string, maxDepth = 6): Map<string, number> {
  const depth = new Map<string, number>();
  let frontier = [id];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const e of adj.out.get(n) ?? []) {
        if (e.to === id || depth.has(e.to)) continue;
        depth.set(e.to, d);
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return depth;
}

export interface GraphStats {
  entries: number;
  assets: number;
  edges: number;
  broken: GraphNode[];
  orphans: GraphNode[]; // content items nobody references
  hubs: { node: GraphNode; direct: number; transitive: number }[];
}

export function graphStats(g: ReferenceGraph): GraphStats {
  const adj = adjacency(g);
  const entries = g.nodes.filter((n) => n.kind === "item");
  const hubs = entries
    .map((node) => ({ node, direct: adj.inc.get(node.id)?.length ?? 0, transitive: dependents(adj, node.id).size }))
    .filter((h) => h.transitive > 0)
    .sort((a, b) => b.transitive - a.transitive || b.direct - a.direct)
    .slice(0, 8);
  return {
    entries: entries.length,
    assets: g.nodes.filter((n) => n.kind === "asset").length,
    edges: g.edges.length,
    broken: g.nodes.filter((n) => n.kind === "missing"),
    orphans: entries.filter((n) => !adj.inc.get(n.id)?.length && !n.unscanned),
    hubs,
  };
}
