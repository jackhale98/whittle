/**
 * Picking and selection (PLAN §9.2): pointer-dependent tolerance, best hit vs. "Which one?"
 * near-ties, highlight items, and the mapping from a viewport hit to a persistent `EntityRef`.
 */

import type {
  EntityKind,
  EntityQuery,
  EntityRef,
  Feature,
  HighlightItem,
  Id,
  MeshBuffers,
  PickHit,
  PickKind,
} from '@wren-cad/contracts';
import { deriveVertices } from '@wren-cad/viewport/ids';

/** Pick radius in CSS px: mouse 6, pen 10, touch 22 (contract `PickOptions`). */
export function toleranceFor(pointerType: string): number {
  return pointerType === 'touch' ? 22 : pointerType === 'pen' ? 10 : 6;
}

const PRIORITY: Record<PickKind, number> = {
  handle: -1,
  sketchPoint: 0,
  vertex: 0,
  sketchCurve: 1,
  edge: 1,
  region: 2,
  face: 2,
};

export const hitKey = (h: Pick<PickHit, 'bodyId' | 'kind' | 'index' | 'entity'>): string =>
  `${h.bodyId}|${h.kind}|${h.index}|${h.entity ?? ''}`;

export function toHighlight(h: PickHit | HighlightItem): HighlightItem {
  return h.entity === undefined
    ? { bodyId: h.bodyId, kind: h.kind, index: h.index }
    : { bodyId: h.bodyId, kind: h.kind, index: h.index, entity: h.entity };
}

/**
 * How close (CSS px) an edge / vertex must be to beat the face directly under the pointer. The
 * full pick tolerance (touch 22 px) still applies off the part, but on a face a finger-sized
 * radius would make every small face lose to its own border: on touch a tap selects the face
 * unless it lands right on an edge or vertex.
 */
export function thinSnapPx(pointerType: string): { edge: number; vertex: number } {
  if (pointerType === 'touch') return { edge: 8, vertex: 11 };
  if (pointerType === 'pen') return { edge: 6, vertex: 8 };
  return { edge: 6, vertex: 6 };
}

export interface ResolvedPick {
  best: PickHit | null;
  /** Distinct candidates too close to call (≥ 2 means: show the chooser). */
  ties: PickHit[];
}

/**
 * Picks the best hit (thin things beat surfaces) and reports near-ties: other thin candidates
 * within `tiePx` of the best one, or — on touch — a vertex/edge competing with each other.
 */
export function resolvePick(
  hits: readonly PickHit[],
  options: { kinds?: readonly PickKind[]; tiePx?: number; pointerType?: string } = {},
): ResolvedPick {
  const tie = options.tiePx ?? 2;
  let list = hits.filter((h) => !options.kinds || options.kinds.includes(h.kind));
  // A surface right under the pointer keeps thin things that are merely "within tolerance" out.
  const onSurface = list.some(
    (h) => (h.kind === 'face' || h.kind === 'region') && h.distancePx < 1,
  );
  if (onSurface) {
    const snap = thinSnapPx(options.pointerType ?? 'mouse');
    list = list.filter(
      (h) =>
        (h.kind !== 'edge' || h.distancePx <= snap.edge) &&
        (h.kind !== 'vertex' || h.distancePx <= snap.vertex),
    );
  }
  const seen = new Set<string>();
  const unique = list.filter((h) => {
    const k = hitKey(h);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // A visible sketch region drawn over a face is what the user sees there: it wins the tie
  // (holes sketched on a face are tapped to cut them; the face around them stays pickable).
  const wins = (h: PickHit, b: PickHit) =>
    PRIORITY[h.kind] < PRIORITY[b.kind] ||
    (PRIORITY[h.kind] === PRIORITY[b.kind] &&
      (h.distancePx < b.distancePx ||
        (h.distancePx === b.distancePx && h.kind === 'region' && b.kind === 'face')));
  let best: PickHit | null = null;
  for (const h of unique) if (!best || wins(h, best)) best = h;
  if (!best) return { best: null, ties: [] };
  const b = best;
  const ties = unique.filter(
    (h) => PRIORITY[h.kind] < 2 && Math.abs(h.distancePx - b.distancePx) <= tie,
  );
  return { best, ties: ties.length > 1 ? ties : [] };
}

/**
 * Viewport hits with stacked sketch regions ordered as the user sees them: all regions are
 * "0 px away", so the one nearest the camera comes first; coplanar ones (a slot sketched on the
 * plate's own plane) are equally near, and the smaller is the specific thing under the cursor,
 * as a hole region over its face. Non-region hits keep their order, before the regions.
 */
export function orderStackedRegions(
  hits: readonly PickHit[],
  camera: readonly [number, number, number],
  areaOf: (h: PickHit) => number,
): PickHit[] {
  const d = (h: PickHit) => Math.hypot(...h.point.map((c, k) => c - (camera[k] as number)));
  const regions = hits
    .filter((h) => h.kind === 'region')
    .sort((p, q) => {
      const dp = d(p);
      const dq = d(q);
      if (Math.abs(dp - dq) > 1e-6 * Math.max(1, dp, dq)) return dp - dq;
      return areaOf(p) - areaOf(q);
    });
  return [...hits.filter((h) => h.kind !== 'region'), ...regions];
}

/** Selection noun for a hit (SelectionInspector kinds). */
export function selectionKind(kind: PickKind): 'face' | 'edge' | 'vertex' | 'region' {
  switch (kind) {
    case 'face':
      return 'face';
    case 'edge':
    case 'sketchCurve':
      return 'edge';
    case 'vertex':
    case 'sketchPoint':
      return 'vertex';
    case 'region':
      return 'region';
    case 'handle': // handles are dragged, never selected; callers filter them out
      return 'face';
  }
}

/** Local reference for sketch picks (names per naming.ts); null when the engine must answer. */
export function sketchRef(hit: PickHit): EntityRef | null {
  if (hit.kind === 'region' && hit.entity) return { name: hit.entity, kind: 'region' };
  if (hit.kind === 'sketchCurve' && hit.entity)
    return { name: `S${hit.bodyId}:e(${hit.entity})`, kind: 'edge' };
  if (hit.kind === 'sketchPoint' && hit.entity)
    return { name: `S${hit.bodyId}:p(${hit.entity})`, kind: 'vertex' };
  return null;
}

/** The engine query for a body pick. */
export function queryFor(hit: PickHit): EntityQuery | null {
  if (hit.kind === 'face' || hit.kind === 'edge' || hit.kind === 'vertex')
    return { bodyId: hit.bodyId, kind: hit.kind, index: hit.index };
  return null;
}

/** Selection → `EntityRef`: sketch picks locally, body picks through `refFor` (engine). */
export async function refForHit(
  hit: PickHit,
  partId: Id,
  refFor: (partId: Id, query: EntityQuery) => Promise<EntityRef | null>,
  as?: EntityKind,
): Promise<EntityRef | null> {
  if (as === 'body') return { name: hit.bodyId, kind: 'body' };
  const local = sketchRef(hit);
  if (local) return local;
  const q = queryFor(hit);
  return q ? refFor(partId, q) : null;
}

/**
 * Reference geometry a pick field takes that has no pickable shape in the view (origin planes and
 * axes, plane / axis / point features): offered as chips next to the prompt.
 */
export type RefChoice = 'plane' | 'axis' | 'point';

export interface Accepts {
  kinds: PickKind[];
  as?: EntityKind;
  noun: string;
  /** Reference geometry chips to offer (origin planes and axes, reference features). */
  refs?: RefChoice[];
  /** The field lists features (mirror / pattern sources): tree clicks and model clicks add one. */
  features?: boolean;
}

const PLANES: Accepts = { kinds: ['face'], noun: 'a plane or flat face', refs: ['plane'] };
const AXES: Accepts = {
  kinds: ['sketchCurve', 'edge'],
  noun: 'an axis or straight edge',
  refs: ['axis'],
};
const POINTS: Accepts = {
  kinds: ['sketchPoint', 'vertex'],
  noun: 'a point or vertex',
  refs: ['point'],
};

/**
 * What a feature's pick field accepts in the viewport, and how hits are turned into refs. Some
 * fields depend on the feature (`/definition/a` is a plane for a midplane and a point for a
 * two-point axis): pass it when known.
 */
export function acceptsFor(path: string, feature?: Feature): Accepts {
  const root = path.replace(/\/\d+$/, '');
  const def =
    feature && 'definition' in feature ? (feature.definition as { kind: string }).kind : null;
  switch (root) {
    case '/edges':
      return { kinds: ['edge'], noun: 'edges' };
    case '/profile':
      return { kinds: ['region'], noun: 'sketch regions' };
    case '/sections':
      return { kinds: ['region'], noun: 'section regions, in order' };
    case '/path':
    case '/guides':
      return { kinds: ['sketchCurve', 'edge'], noun: 'path curves, in order' };
    case '/axis':
    case '/definition/axis':
      return AXES;
    case '/direction':
    case '/second/direction':
      return {
        kinds: ['sketchCurve', 'edge'],
        noun: 'a direction: an edge, an axis or a plane',
        refs: ['axis', 'plane'],
      };
    case '/plane':
    case '/neutral':
    case '/definition/from':
    case '/definition/plane':
      return PLANES;
    case '/end/target':
    case '/on':
    case '/mode/face':
    case '/face':
    case '/definition/face':
      return { kinds: ['face'], noun: 'a face' };
    case '/faces':
    case '/openFaces':
      return { kinds: ['face'], noun: 'faces' };
    case '/points':
    case '/definition/points':
    case '/definition/point':
    case '/definition/at':
    case '/definition/vertex':
      return POINTS;
    case '/definition/edge':
    case '/definition/curve':
      return { kinds: ['sketchCurve', 'edge'], noun: 'an edge' };
    case '/definition/of':
      return { kinds: ['edge', 'face'], noun: 'a circular edge or a sphere' };
    case '/definition/a':
    case '/definition/b':
      if (def === 'twoPoints') return POINTS;
      if (def === 'midplane' || def === 'twoPlanes') return PLANES;
      return {
        kinds: ['face', 'edge', 'sketchCurve'],
        noun: 'a plane, an axis or an edge',
        refs: ['plane', 'axis'],
      };
    case '/source/features':
      return { kinds: ['face'], noun: 'features, in the tree or the model', features: true };
    case '/target':
    case '/tools':
    case '/body':
    case '/scope/bodies':
    case '/source/bodies':
      return { kinds: ['face'], as: 'body', noun: 'bodies' };
    default:
      return { kinds: ['face', 'edge', 'vertex'], noun: 'geometry' };
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Applies a picked ref to a feature field: an array path (`/edges`) appends (no duplicates), an
 * element path (`/edges/2`) replaces that entry, any other path sets the field.
 */
export function applyPick<F extends Feature>(feature: F, path: string, ref: EntityRef): F {
  const segs = path.split('/').slice(1);
  const root = structuredClone(feature) as unknown as Json;
  let parent: Json = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i] as string;
    const next: Json | undefined = Array.isArray(parent)
      ? parent[Number(s)]
      : parent && typeof parent === 'object'
        ? (parent as Record<string, Json>)[s]
        : undefined;
    if (next === undefined || next === null || typeof next !== 'object') return feature;
    parent = next;
  }
  const last = segs[segs.length - 1] as string;
  const value = ref as unknown as Json;
  if (Array.isArray(parent)) {
    const i = Number(last);
    if (Number.isInteger(i) && i >= 0 && i < parent.length) parent[i] = value;
    return root as unknown as F;
  }
  if (!parent || typeof parent !== 'object') return feature;
  const obj = parent as Record<string, Json>;
  const cur = obj[last];
  if (Array.isArray(cur)) {
    if (!cur.some((r) => (r as { name?: string } | null)?.name === ref.name)) cur.push(value);
  } else if (last in obj) obj[last] = value;
  else return feature;
  return root as unknown as F;
}

/**
 * The body's vertices numbered exactly as the viewport picks them (distinct edge-polyline
 * endpoints, `deriveVertices`), so a remapped index highlights the same vertex. The kernel's
 * optional `vertexPositions` is not used: its order is TopExp's, not the viewport's.
 */
export function pickVertices(mesh: MeshBuffers | undefined): Float32Array | undefined {
  return mesh ? deriveVertices(mesh.edgePositions, mesh.edgeRanges, mesh.bbox) : undefined;
}

/**
 * Index of the vertex at `point` (within `tol` mm) in `positions` (from `pickVertices`), or -1.
 * Vertices carry no persistent names in the mesh, so a selected vertex is re-found by position
 * after a regen (a vertex that moved is dropped, never guessed).
 */
export function vertexAt(
  positions: Float32Array | undefined,
  point: readonly [number, number, number],
  tol = 1e-3,
): number {
  if (!positions) return -1;
  let best = -1;
  let bestD = tol * tol;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const dx = (positions[i] as number) - point[0];
    const dy = (positions[i + 1] as number) - point[1];
    const dz = (positions[i + 2] as number) - point[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d <= bestD) {
      bestD = d;
      best = i / 3;
    }
  }
  return best;
}
