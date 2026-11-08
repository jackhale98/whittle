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
