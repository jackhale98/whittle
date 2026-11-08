/**
 * Human wording for entities, constraints and conflicts ("Line 2 can't be both horizontal and at
 * 30° to Line 1"). Entities are named by kind and 1-based ordinal in the sketch's entity order.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  DimensionConstraint,
  Id,
  SketchConstraint,
  SketchEntity,
  SuggestedFix,
} from '@whittle/contracts';

const KIND_LABEL: Record<SketchEntity['kind'], string> = {
  point: 'Point',
  line: 'Line',
  circle: 'Circle',
  arc: 'Arc',
  ellipse: 'Ellipse',
};

const CONSTRAINT_LABEL: Record<SketchConstraint['kind'], string> = {
  coincident: 'Coincident',
  pointOn: 'Point on',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  horizontalPoints: 'Horizontal',
  verticalPoints: 'Vertical',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
  equal: 'Equal',
  midpoint: 'Midpoint',
  concentric: 'Concentric',
  symmetric: 'Symmetric',
  fix: 'Fix',
  distance: 'Distance',
  hDistance: 'Horizontal distance',
  vDistance: 'Vertical distance',
  length: 'Length',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
};

export function formatLength(mm: number): string {
  return `${trim(mm)} mm`;
}

export function formatAngle(rad: number): string {
  return `${trim((rad * 180) / Math.PI)}°`;
}

function trim(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString();
}

export class Namer {
  private names = new Map<Id, string>();
  constructor(entities: readonly SketchEntity[]) {
    const counts: Record<string, number> = {};
    for (const e of entities) {
      counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      this.names.set(e.id, `${KIND_LABEL[e.kind]} ${counts[e.kind]}`);
    }
  }
  entity(id: Id): string {
    return this.names.get(id) ?? 'unknown geometry';
  }
}

export function formatDimensionValue(c: DimensionConstraint, value: number): string {
  if (c.kind === 'angle') return formatAngle(value);
  if (c.kind === 'diameter') return `⌀${formatLength(value)}`;
  if (c.kind === 'radius') return `R${formatLength(value)}`;
  return formatLength(value);
}

/** Top-level entities a constraint talks about (for picking the conflict's subject). */
export function referencedEntities(c: SketchConstraint): Id[] {
  switch (c.kind) {
    case 'horizontal':
    case 'vertical':
    case 'length':
      return [c.line];
    case 'radius':
    case 'diameter':
      return [c.curve];
    case 'pointOn':
      return [c.point, c.on];
    case 'midpoint':
      return [c.point, c.line];
    case 'symmetric':
      return [c.a, c.b, c.about];
    case 'fix':
      return [c.entity];
    default:
      return [c.a, c.b];
  }
}

/** Short label for a constraint, e.g. "Horizontal (Line 2)" or "Angle 30° (Line 1, Line 2)". */
export function constraintLabel(
  c: SketchConstraint,
  namer: Namer,
  values: Record<Id, number>,
): string {
  const refs = [...new Set(referencedEntities(c))].map((id) => namer.entity(id)).join(', ');
  const base = CONSTRAINT_LABEL[c.kind];
  if ('value' in c) {
    const v = values[c.id];
    return `${base}${v === undefined ? '' : ` ${formatDimensionValue(c, v)}`} (${refs})`;
  }
  return `${base} (${refs})`;
}

/** Describes what a constraint asks of `subject`, e.g. "at 30° to Line 1". */
export function describeFor(
  c: SketchConstraint,
  subject: Id,
  namer: Namer,
  values: Record<Id, number>,
): string {
  const other = (a: Id, b: Id) => namer.entity(a === subject ? b : a);
  const v = 'value' in c ? values[c.id] : undefined;
  switch (c.kind) {
    case 'horizontal':
      return 'horizontal';
    case 'vertical':
      return 'vertical';
    case 'horizontalPoints':
      return `level with ${other(c.a, c.b)}`;
    case 'verticalPoints':
      return `vertically aligned with ${other(c.a, c.b)}`;
    case 'coincident':
      return `coincident with ${other(c.a, c.b)}`;
    case 'pointOn':
      return subject === c.point ? `on ${namer.entity(c.on)}` : `through ${namer.entity(c.point)}`;
    case 'parallel':
      return `parallel to ${other(c.a, c.b)}`;
    case 'perpendicular':
      return `perpendicular to ${other(c.a, c.b)}`;
    case 'tangent':
      return `tangent to ${other(c.a, c.b)}`;
    case 'equal':
      return `equal to ${other(c.a, c.b)}`;
    case 'midpoint':
      return subject === c.point
        ? `at the midpoint of ${namer.entity(c.line)}`
        : `bisected by ${namer.entity(c.point)}`;
    case 'concentric':
      return `concentric with ${other(c.a, c.b)}`;
    case 'symmetric':
      return subject === c.about
        ? `the mirror line of ${namer.entity(c.a)} and ${namer.entity(c.b)}`
        : `symmetric with ${other(c.a, c.b)} about ${namer.entity(c.about)}`;
    case 'fix':
      return 'fixed';
    case 'length':
      return v === undefined ? 'a fixed length' : `${formatLength(v)} long`;
    case 'radius':
      return v === undefined ? 'a fixed radius' : `radius ${formatLength(v)}`;
    case 'diameter':
      return v === undefined ? 'a fixed diameter' : `diameter ${formatLength(v)}`;
    case 'distance':
      return `${v === undefined ? 'a set distance' : formatLength(v)} from ${other(c.a, c.b)}`;
    case 'hDistance':
      return `${v === undefined ? 'a set distance' : formatLength(Math.abs(v))} horizontally from ${other(c.a, c.b)}`;
    case 'vDistance':
      return `${v === undefined ? 'a set distance' : formatLength(Math.abs(v))} vertically from ${other(c.a, c.b)}`;
    case 'angle':
      return `at ${v === undefined ? 'a set angle' : formatAngle(v)} to ${other(c.a, c.b)}`;
  }
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Explanation for a minimal conflicting set. `fixed` lists grounded entities that take part
 * (the set is only contradictory because they can't move).
 */
export function explainConflict(
  set: readonly SketchConstraint[],
  fixed: readonly Id[],
  namer: Namer,
  values: Record<Id, number>,
): string {
  const fixedNote =
    fixed.length === 0
      ? ''
      : ` while ${joinAnd(fixed.map((id) => namer.entity(id)))} ${fixed.length === 1 ? 'is' : 'are'} fixed`;
  if (set.length === 1) {
    const c = set[0] as SketchConstraint;
    const subject = referencedEntities(c)[0] as Id;
    return `${namer.entity(subject)} can't be ${describeFor(c, subject, namer, values)}${fixedNote || ' with the current geometry'}`;
  }
  // A subject every constraint mentions, preferring the most specific (first) reference.
  const refSets = set.map((c) => new Set(referencedEntities(c)));
  const subject = referencedEntities(set[0] as SketchConstraint).find((id) =>
    refSets.every((s) => s.has(id)),
  );
  if (subject !== undefined) {
    const parts = set.map((c) => describeFor(c, subject, namer, values));
    const name = namer.entity(subject);
    if (parts.length === 2) return `${name} can't be both ${parts[0]} and ${parts[1]}${fixedNote}`;
    return `${name} can't be ${joinAnd(parts)} at the same time${fixedNote}`;
  }
  return `These constraints can't all hold: ${set.map((c) => constraintLabel(c, namer, values)).join('; ')}${fixedNote}`;
}

export function fixLabel(fix: SuggestedFix['action'], label: string, c: SketchConstraint): string {
  switch (fix.kind) {
    case 'removeConstraint':
      return `Remove ‘${label}’`;
    case 'makeReference':
      return `Make ‘${label}’ a reference dimension`;
    case 'setValue':
      return `Set ‘${label}’ to ${'value' in c ? formatDimensionValue(c, fix.value) : String(fix.value)}`;
  }
}
