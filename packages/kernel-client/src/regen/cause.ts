/**
 * Error causes (M3.5, ADR-046, PLAN §7.3): which upstream feature's change broke a reference or a
 * feature, so the UI can say "Fillet 2 lost its edge because Extrude 1 changed (depth 10 mm →
 * 4 mm)" and select Extrude 1. Reported only when the engine can tell; never a guess.
 *
 * Every regen records a **walk**: per feature its position, state, definition and evaluated
 * values (`own`), cache key, the features whose output it read (`deps`), the containers it set
 * (bodies, the sketch, the plane, with their naming maps) and its unresolved refs with their
 * causes. A cause is computed from the persistent name, this walk and the previous regen's walk
 * of the same slot. Rules, first match wins (README "Error causes"):
 *
 *  1. **Structural** (needs no history). The tags in the name (`F<id>:`, `S<id>:`, `B<id>`; the
 *     outermost producers first, then inner tags): a tagged feature that is gone → `deleted`;
 *     suppressed → `suppressed`; now after the consumer → `reordered`; failed this regen →
 *     `failed`. A name can only exist if every feature it records ran before the consumer.
 *  2. **This regen's change** (the ref resolved in the previous regen, with the same stored ref):
 *     the *touchers* of the entity are the features whose output set or removed a container
 *     holding its name family, plus the producer (the latest outermost tag). From the nearest
 *     toucher back: a toucher whose own definition or values changed (or that is new, unsuppressed
 *     or moved above the consumer) → `changed` with the parameter in `detail`; a toucher whose
 *     cache key changed only through its inputs → the nearest change in its dependency chain
 *     (breadth-first over `deps` through features whose keys changed; a feature removed from that
 *     chain counts with its kind). Two changes at the same distance → none.
 *     A toucher with an unchanged key is skipped (its output is identical to last time).
 *     Fallback: when exactly one feature upstream of the consumer changed, was added or was
 *     removed, it is the cause (regeneration is deterministic, so nothing else can be).
 *  3. **Carried over**: a ref that was already unresolved last regen, with the same stored ref,
 *     keeps the cause it had while that cause still holds (the feature still exists upstream,
 *     or is still gone / suppressed / after the consumer).
 *
 * `error` features use rules 2 and 3 with the feature itself in place of the toucher when it ran
 * ok last time and its own definition is unchanged (an edit to the feature itself is not an
 * upstream cause). `needsAttention` features take the cause of their first unresolved ref that has
 * one. `blocked` features name the failing feature they wait on (`failed`), see the engine.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AttentionCause,
  Feature,
  FeatureStatus,
  Id,
  NamedDimension,
  NamingMap,
  Part,
} from '@wren-cad/contracts';
import { exprFields } from '@wren-cad/document';
import { baseName } from './resolve';

/** A container of named sub-shapes in the walk state (a body, a sketch, a plane, a datum). */
export interface WalkContainer {
  /** Body id, or `sketch:<id>` / `plane:<id>` / `datum:<id>` (the resolver's owners). */
  id: string;
  naming: NamingMap;
}

export interface WalkEntry {
  id: Id;
  state: FeatureStatus['state'];
  /** Canonical JSON of the definition (name, suppressed, annotations dropped). */
  def?: string;
  /** Evaluated values (mm, rad, counts), annotations excluded. */
  values?: Record<string, number>;
  /** Pointers of values that did not evaluate. */
  valueErrors?: string[];
  /** Cache key, when the feature was planned. */
  key?: string;
  /** A plan existed: every reference of the feature resolved. */
  planned: boolean;
  /** Features whose output this one read (references and the bodies it acted on). */
  deps: Id[];
  /** Ok features: the containers it set and the body ids it removed. */
  delta?: { set: WalkContainer[]; remove: string[] };
  unresolved?: { path: string; cause?: AttentionCause }[];
  cause?: AttentionCause;
}

export interface Walk {
  entries: WalkEntry[];
  byId: Map<Id, WalkEntry>;
  pos: Map<Id, number>;
}

export function newWalk(): Walk {
  return { entries: [], byId: new Map(), pos: new Map() };
}

export function pushWalk(w: Walk, e: WalkEntry): void {
  w.pos.set(e.id, w.entries.length);
  w.entries.push(e);
  w.byId.set(e.id, e);
}

/** What a cause is computed against: the current part and walk, and the previous regen's walk. */
export interface CauseEnv {
  part: Part;
  /** Position of every feature in `part.features`. */
  index: ReadonlyMap<Id, number>;
  /** This regen's walk so far (the consumer is the last entry, or not yet in it). */
  walk: Walk;
  prev: Walk | null;
  /** User-facing field label (`Depth`, `Radius`, …) for `detail`. */
  label: (f: Feature, pointer: string) => string;
}

const ACTIVE = (s: FeatureStatus['state'] | undefined) =>
  s !== undefined && s !== 'suppressed' && s !== 'rolledBack';
const FAILED = (s: FeatureStatus['state'] | undefined) =>
  s === 'error' || s === 'needsAttention' || s === 'blocked';

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

const TAG = /(?<![0-9A-Za-z])[FS]([0-9A-Za-z]+):/g;
/** `B<id>` / `B<id>#k` body refs, and `F<id>` (a copy feature's missing source feature). */
const BODY = /^[BF]([0-9A-Za-z]+)(?:#\d+)?$/;

/** Splits `edge(a|b)` / `vertex(a|b|c)` into its components (top level only). */
function components(name: string): string[] {
  const m = /^(?:edge|vertex)\((.*)\)(?:#\d+)?$/.exec(name);
  if (!m) return [name];
  const inner = m[1] as string;
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) {
      out.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  out.push(inner.slice(from));
  return out;
}

/**
 * Feature ids recorded in a persistent name: `outer` = the feature that made each top-level
 * component (its leading tag; for `edge(…)`/`vertex(…)` one per adjacent face), `all` = every
 * tag, outer ones first, each once.
 */
export function nameTags(name: string, kind?: string): { outer: Id[]; all: Id[] } {
  if (kind === 'body') {
    const b = BODY.exec(name);
    return b ? { outer: [b[1] as Id], all: [b[1] as Id] } : { outer: [], all: [] };
  }
  const outer: Id[] = [];
  for (const c of components(name)) {
    const m = /^[FS]([0-9A-Za-z]+):/.exec(c);
    if (m && !outer.includes(m[1] as Id)) outer.push(m[1] as Id);
  }
  const all = [...outer];
  for (const m of name.matchAll(TAG)) if (!all.includes(m[1] as Id)) all.push(m[1] as Id);
  return { outer, all };
}

// ---------------------------------------------------------------------------------------------
// Rule 1: structural
// ---------------------------------------------------------------------------------------------

/** Deleted / suppressed / reordered / failed producers of a name, relative to the consumer. */
export function structuralCause(
  env: CauseEnv,
  consumer: Id,
  name: string,
  kind?: string,
): AttentionCause | null {
  const at = env.index.get(consumer) ?? Number.POSITIVE_INFINITY;
  for (const id of nameTags(name, kind).all) {
    if (id === consumer) continue;
    const i = env.index.get(id);
    if (i === undefined) return { featureId: id, kind: 'deleted' };
    const f = env.part.features[i] as Feature;
    if (f.suppressed && i < at) return { featureId: id, kind: 'suppressed' };
    if (i > at) return { featureId: id, kind: 'reordered' };
    if (FAILED(env.walk.byId.get(id)?.state)) return { featureId: id, kind: 'failed' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rule 2: this regen's change
// ---------------------------------------------------------------------------------------------

function feature(env: CauseEnv, id: Id): Feature | undefined {
  const i = env.index.get(id);
  return i === undefined ? undefined : env.part.features[i];
}

/** Was `x` upstream of `c` in the previous walk? */
function wasBefore(prev: Walk, x: Id, c: Id): boolean {
  const px = prev.pos.get(x);
  const pc = prev.pos.get(c);
  return px !== undefined && pc !== undefined && px < pc;
}

/**
 * Is `e` (this walk, upstream of consumer `c`) itself a change since the previous regen: new,
 * unsuppressed, moved above the consumer, or its definition or values changed? Returns the cause.
 */
function ownChange(env: CauseEnv, e: WalkEntry, c: Id): AttentionCause | null {
  const prev = env.prev;
  if (!prev) return null;
  const p = prev.byId.get(e.id);
  const changed = (detail?: string): AttentionCause =>
    detail ? { featureId: e.id, kind: 'changed', detail } : { featureId: e.id, kind: 'changed' };
  if (!p) return changed('added');
  if (p.state === 'suppressed') return changed('unsuppressed');
  if (p.state === 'rolledBack') return changed('rolled forward');
  if (p.def !== e.def || !sameValues(p, e)) return changed(changeDetail(env, p, e));
  if (e.id !== c && prev.pos.has(c) && !wasBefore(prev, e.id, c)) return changed('moved');
  return null;
}

function keyChanged(env: CauseEnv, e: WalkEntry): boolean {
  const p = env.prev?.byId.get(e.id);
  return !p || p.key === undefined || e.key === undefined || p.key !== e.key;
}

/**
 * Features upstream of `c` in the previous walk that are not upstream now (deleted, suppressed,
 * moved below it), with their cause kinds; `among` restricts the candidates.
 */
function removedUpstream(env: CauseEnv, c: Id, among?: readonly Id[]): AttentionCause[] {
  const prev = env.prev;
  if (!prev?.pos.has(c)) return [];
  const at = env.index.get(c) ?? Number.POSITIVE_INFINITY;
  const out: AttentionCause[] = [];
  const ids = among ?? prev.entries.map((e) => e.id);
  for (const id of ids) {
    const p = prev.byId.get(id);
    if (!p || !ACTIVE(p.state) || !wasBefore(prev, id, c)) continue;
    const i = env.index.get(id);
    if (i === undefined) out.push({ featureId: id, kind: 'deleted' });
    else if ((env.part.features[i] as Feature).suppressed) {
      out.push({ featureId: id, kind: 'suppressed' });
    } else if (i > at) out.push({ featureId: id, kind: 'reordered' });
  }
  return out;
}

/**
 * Nearest change in the dependency chain of `start` (whose key changed through its inputs):
 * breadth-first over `deps`, expanding only features whose keys changed; a changed or removed
 * feature ends its branch. Unique at the smallest distance, else null.
 */
function nearestChange(env: CauseEnv, start: WalkEntry, c: Id): AttentionCause | null {
  let level: WalkEntry[] = [start];
  const seen = new Set<Id>([start.id]);
  while (level.length > 0) {
    const found: AttentionCause[] = [];
    const next: WalkEntry[] = [];
    for (const x of level) {
      const prevDeps = env.prev?.byId.get(x.id)?.deps ?? [];
      const gone = removedUpstream(
        env,
        c,
        prevDeps.filter((d) => !x.deps.includes(d)),
      );
      for (const g of gone) {
        if (seen.has(g.featureId)) continue;
        seen.add(g.featureId);
        found.push(g);
      }
      for (const d of x.deps) {
        if (seen.has(d)) continue;
        seen.add(d);
        const e = env.walk.byId.get(d);
        if (!e || !ACTIVE(e.state)) continue;
        const own = ownChange(env, e, c);
        if (own) found.push(own);
        else if (keyChanged(env, e)) next.push(e);
      }
    }
    if (found.length === 1) return found[0] as AttentionCause;
    if (found.length > 1) return null;
    level = next;
  }
  return null;
}

/** Exactly one change upstream of `c` (changed, added, removed): that one; else null. */
function soleChange(env: CauseEnv, c: Id): AttentionCause | null {
  const out: AttentionCause[] = [];
  for (const e of env.walk.entries) {
    if (e.id === c) break;
    if (!ACTIVE(e.state)) continue;
    const own = ownChange(env, e, c);
    if (own) out.push(own);
    if (out.length > 1) return null;
  }
  out.push(...removedUpstream(env, c));
  return out.length === 1 ? (out[0] as AttentionCause) : null;
}

/**
 * The features of this walk upstream of `c` that set or removed a container holding a member of
 * the name's family (exact name or the same name up to `#k`), nearest first, plus the producer.
 */
function touchers(env: CauseEnv, c: Id, name: string, kind: string): WalkEntry[] {
  const fam = baseName(name);
  const sub = kind === 'region' ? 'face' : kind;
  const holds = (cont: WalkContainer): boolean =>
    kind === 'body'
      ? baseName(cont.id) === fam
      : cont.naming.some((n) => n.kind === sub && baseName(n.name) === fam);
  const live = new Map<string, WalkContainer>();
  const out: WalkEntry[] = [];
  for (const e of env.walk.entries) {
    if (e.id === c) break;
    if (!e.delta) continue;
    let touched = false;
    for (const id of e.delta.remove) {
      const had = live.get(id);
      if (had && holds(had)) touched = true;
      live.delete(id);
    }
    for (const cont of e.delta.set) {
      const had = live.get(cont.id);
      if ((had && holds(had)) || holds(cont)) touched = true;
      live.set(cont.id, cont);
    }
    if (touched) out.push(e);
  }
  // The producer: the latest feature that made a top-level component of the name.
  let producer: WalkEntry | undefined;
  for (const id of nameTags(name, kind).outer) {
    const e = env.walk.byId.get(id);
    if (e && (!producer || (env.walk.pos.get(id) ?? 0) > (env.walk.pos.get(producer.id) ?? 0))) {
      producer = e;
    }
  }
  if (producer && !out.includes(producer) && env.walk.pos.has(producer.id)) {
    const at = env.walk.pos.get(producer.id) as number;
    if (at < (env.walk.pos.get(c) ?? Number.POSITIVE_INFINITY)) out.push(producer);
  }
  return out.sort((a, b) => (env.walk.pos.get(b.id) ?? 0) - (env.walk.pos.get(a.id) ?? 0));
}

/** Rule 2 for an entity name the consumer `c` could resolve last regen and cannot now. */
export function changeCause(
  env: CauseEnv,
  c: Id,
  name: string,
  kind: string,
): AttentionCause | null {
  if (!env.prev) return null;
  for (const t of touchers(env, c, name, kind)) {
    const own = ownChange(env, t, c);
    if (own) return own;
    if (keyChanged(env, t)) return nearestChange(env, t, c) ?? soleChange(env, c);
  }
  return soleChange(env, c);
}

/** Rule 2 for a feature that ran ok last regen and fails now with its own definition unchanged. */
export function upstreamCause(env: CauseEnv, e: WalkEntry): AttentionCause | null {
  if (!env.prev || ownChange(env, e, e.id)) return null;
  return nearestChange(env, e, e.id) ?? soleChange(env, e.id);
}

/** Is a carried-over cause still true for consumer `c` (rule 3)? */
export function stillHolds(env: CauseEnv, c: Id, cause: AttentionCause): boolean {
  const i = env.index.get(cause.featureId);
  const at = env.index.get(c) ?? Number.POSITIVE_INFINITY;
  const f = i === undefined ? undefined : env.part.features[i];
  switch (cause.kind) {
    case 'deleted':
      return f === undefined;
    case 'suppressed':
      return f?.suppressed === true;
    case 'reordered':
      return i !== undefined && i > at;
    default:
      return f !== undefined && !f.suppressed && (i as number) < at;
  }
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

function sameValues(a: WalkEntry, b: WalkEntry): boolean {
  const va = a.values ?? {};
  const vb = b.values ?? {};
  const ka = Object.keys(va);
  if (ka.length !== Object.keys(vb).length) return false;
  for (const k of ka) if (!(k in vb) || !close(va[k] as number, vb[k] as number)) return false;
  return (a.valueErrors ?? []).join('\n') === (b.valueErrors ?? []).join('\n');
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a));

function fmt(v: number, dim: NamedDimension | undefined): string {
  const n = (x: number) => String(Number(x.toPrecision(6)));
  if (dim === 'angle') return `${n((v * 180) / Math.PI)}°`;
  if (dim === 'length') return `${n(v)} mm`;
  return n(v);
}

const KEY_LABELS: Record<string, string> = {
  profile: 'profile',
  end: 'end condition',
  op: 'operation',
  direction: 'direction',
  scope: 'bodies',
  entities: 'sketch geometry',
  constraints: 'sketch constraints',
  on: 'sketch plane',
  edges: 'edges',
  faces: 'faces',
  axis: 'axis',
  definition: 'definition',
  source: 'source',
  shape: 'shape',
  frame: 'placement',
};

/** "depth 10 mm → 4 mm", "sketch geometry changed", …; undefined when nothing is nameable. */
function changeDetail(env: CauseEnv, prev: WalkEntry, now: WalkEntry): string | undefined {
  const f = feature(env, now.id);
  if (!f) return undefined;
  const dims = new Map(exprFields(f).map((x) => [x.pointer, x.expected]));
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const pv = prev.values ?? {};
  const nv = now.values ?? {};
  for (const [ptr, v] of Object.entries(nv)) {
    const o = pv[ptr];
    const label = lower(env.label(f, ptr));
    if (o === undefined) return `${label} set to ${fmt(v, dims.get(ptr))}`;
    if (!close(o, v)) return `${label} ${fmt(o, dims.get(ptr))} → ${fmt(v, dims.get(ptr))}`;
  }
  for (const ptr of Object.keys(pv)) {
    if (!(ptr in nv)) return `${lower(env.label(f, ptr))} removed`;
  }
  if (prev.def === undefined || now.def === undefined || prev.def === now.def) return undefined;
  try {
    const a = JSON.parse(prev.def) as Record<string, unknown>;
    const b = JSON.parse(now.def) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return `${KEY_LABELS[k] ?? k} changed`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The value at a JSON pointer of a feature definition (JSON text or object). */
export function valueAt(def: string | object | undefined, pointer: string): unknown {
  if (def === undefined) return undefined;
  let v: unknown = typeof def === 'string' ? safeParse(def) : def;
  for (const raw of pointer.split('/').slice(1)) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** The stored ref's identity at a path (its name, or the raw value for id lists). */
export function refIdentity(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
    return `${(v as { kind?: string }).kind ?? ''}|${(v as { name: string }).name}`;
  }
  return undefined;
}
