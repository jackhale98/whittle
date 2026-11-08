/**
 * Measure (PLAN §9.1 phone, desktop/tablet Inspect): picks → contract `MeasureTarget`s, and the
 * viewport markers and HTML label anchors for a result. The kernel measures exactly
 * (`ModelingApi.measure`); this module only describes where to draw it.
 */

import type { Marker, Measurement, MeasureTarget, PickHit, Vec3 } from '@whittle/contracts';

export interface MeasurePick {
  id: string;
  /** "Face", "Edge", "Vertex", or a named reference ("Edge of Extrude 1"). */
  label: string;
  kind: 'face' | 'edge' | 'vertex' | 'point';
  target: MeasureTarget;
  /** Where it was picked (mm): the marker and the label anchor. */
  at: Vec3;
  /** Persistent name of a picked face or edge (the mesh's `faceNames`/`edgeNames` entry). */
  name?: string;
  /** Position of a picked vertex (meshes carry no vertex names). */
  vertexAt?: Vec3;
}

/** The parts of a body's render mesh that `remapPicks` and `pickIdentity` read. */
export interface PickMesh {
  faceNames: readonly string[];
  edgeNames: readonly string[];
  vertexPositions?: ArrayLike<number>;
}

function vertexAt(mesh: PickMesh, index: number): Vec3 | undefined {
  const v = mesh.vertexPositions;
  const i = index * 3;
  if (!v || index < 0 || i + 2 >= v.length) return undefined;
  return [v[i] as number, v[i + 1] as number, v[i + 2] as number];
}

/**
 * What identifies a body sub-shape pick across regens: a face's or edge's persistent name, or a
 * vertex's position. Empty when the mesh has neither (the pick is then dropped by the next regen).
 */
export function pickIdentity(
  target: MeasureTarget,
  mesh: PickMesh | undefined,
): Pick<MeasurePick, 'name' | 'vertexAt'> {
  if (!mesh || !('bodyId' in target)) return {};
  if (target.kind === 'vertex') {
    const at = vertexAt(mesh, target.index);
    return at ? { vertexAt: at } : {};
  }
  const names = target.kind === 'face' ? mesh.faceNames : mesh.edgeNames;
  const name = names[target.index];
  return name ? { name } : {};
}

/**
 * Picks after a regen. Mesh ordinals belong to the geometry they were picked on, so face and edge
 * picks are found again by persistent name on the new meshes (as the selection is); a pick whose
 * name no longer resolves, or never had one, is dropped rather than left on whatever now has its
 * ordinal. Render meshes carry no vertex names: a vertex pick stays only while its ordinal is
 * still the same point. Point picks always stay.
 */
export function remapPicks(
  picks: readonly MeasurePick[],
  bodies: ReadonlyArray<{ id: string; mesh: PickMesh }>,
): MeasurePick[] {
  return picks.flatMap((p): MeasurePick[] => {
    const t = p.target;
    if (!('bodyId' in t)) return [p];
    const mesh = bodies.find((b) => b.id === t.bodyId)?.mesh;
    if (!mesh) return [];
    if (t.kind === 'vertex') {
      const now = vertexAt(mesh, t.index);
      const was = p.vertexAt;
      const same =
        !!now &&
        !!was &&
        [0, 1, 2].every((k) => Math.abs((now[k] as number) - (was[k] as number)) <= 1e-6);
      return same ? [p] : [];
    }
    if (!p.name) return [];
    const index = (t.kind === 'face' ? mesh.faceNames : mesh.edgeNames).indexOf(p.name);
    if (index < 0) return [];
    return index === t.index ? [p] : [{ ...p, target: { ...t, index } }];
  });
}

/** A viewport hit as a measure target: sub-shapes of bodies by mesh ordinal, else the point. */
export function measureTargetFor(hit: PickHit): Pick<MeasurePick, 'kind' | 'target' | 'at'> {
  if (hit.kind === 'face' || hit.kind === 'edge' || hit.kind === 'vertex')
    return {
      kind: hit.kind,
      target: { bodyId: hit.bodyId, kind: hit.kind, index: hit.index },
      at: hit.point,
    };
  return { kind: 'point', target: { point: hit.point }, at: hit.point };
}

/** The picks a new pick leaves: up to two, a third starts over from itself. */
export function nextPicks(picks: readonly MeasurePick[], pick: MeasurePick): MeasurePick[] {
  return picks.length >= 2 ? [pick] : [...picks, pick];
}

export interface MeasureLabel {
  id: string;
  at: Vec3;
  text: string;
}

const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const fmt = (n: number, digits = 2) =>
  n
    .toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .replace('-', '−');

/** Short label text for the view: "42.50 mm", "90.00°", "Ø 10.00 mm", "1,800.0 mm²". */
export function labelText(m: Measurement): string | null {
  if (m.distance) {
    const angle = m.angle !== undefined ? ` · ${fmt((m.angle * 180) / Math.PI)}°` : '';
    return `${fmt(m.distance.value)} mm${angle}`;
  }
  if (m.length !== undefined)
    return m.radius !== undefined
      ? `${fmt(m.length)} mm · R ${fmt(m.radius)}`
      : `${fmt(m.length)} mm`;
  if (m.radius !== undefined) return `R ${fmt(m.radius)} mm`;
  if (m.area !== undefined) return `${fmt(m.area, 1)} mm²`;
  if (m.angle !== undefined) return `${fmt((m.angle * 180) / Math.PI)}°`;
  if (m.position) return m.position.map((v) => fmt(v)).join(', ');
  return null;
}

/**
 * Markers for the current picks and result: a dot per pick, and for a distance the closest points
 * joined by a line (dashed when the points are not the picks themselves).
 */
export function measureMarkers(picks: readonly MeasurePick[], m: Measurement | null): Marker[] {
  const out: Marker[] = [];
  if (picks.length) out.push({ kind: 'point', points: picks.map((p) => p.at), tone: 'muted' });
  if (m?.distance) {
    const { a, b } = m.distance;
    out.push({ kind: 'point', points: [a, b], tone: 'accent' });
    if (m.distance.value > 1e-9) out.push({ kind: 'line', points: [a, b], tone: 'accent' });
  } else if (m?.position) out.push({ kind: 'point', points: [m.position], tone: 'accent' });
  return out;
}

/** Where the result's label goes: the middle of the distance line, else the (last) pick. */
export function measureLabel(
  picks: readonly MeasurePick[],
  m: Measurement | null,
): MeasureLabel | null {
  if (!m) return null;
  const text = labelText(m);
  const last = picks[picks.length - 1];
  if (!text) return null;
  if (m.distance) return { id: 'result', at: mid(m.distance.a, m.distance.b), text };
  return last ? { id: 'result', at: m.position ?? last.at, text } : null;
}
