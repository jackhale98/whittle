/**
 * Runtime validation of the `drawing` section of a reference-part spec (see `DrawingSpec`). It
 * returns problems as plain strings (empty = valid), so a test can show all of them at once.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingDimKind, DrawingSpec } from './types';

const KINDS: readonly DrawingDimKind[] = [
  'linear',
  'diameter',
  'radius',
  'chamfer',
  'angle',
  'count',
];
const VIEW_KINDS = ['base', 'projected', 'section', 'detail'];
const ORIENTATIONS = ['front', 'back', 'top', 'bottom', 'left', 'right'];
const AXES = ['X', 'Y', 'Z', '-X', '-Y', '-Z'];
const SIDES = ['above', 'below', 'left', 'right'];

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isPt = (x: unknown): boolean => Array.isArray(x) && x.length === 2 && x.every(isNum);

export function validateDrawingSpec(
  x: unknown,
  dimensions: Record<string, { value: number; unit: string }>,
): string[] {
  const out: string[] = [];
  if (!isObj(x)) return ['drawing is not an object'];
  const d = x as Partial<Record<keyof DrawingSpec, unknown>>;
  if (typeof d.file !== 'string' || !d.file.endsWith('.svg')) out.push('file must be an .svg name');
  if (d.projection !== 'third' && d.projection !== 'first')
    out.push('projection must be third or first');
  if (!Array.isArray(d.views) || d.views.length === 0) return [...out, 'views must be non-empty'];
  if (!Array.isArray(d.dimensions)) return [...out, 'dimensions must be an array'];

  const ids = new Set<string>();
  for (const v of d.views as unknown[]) {
    if (!isObj(v)) {
      out.push('a view is not an object');
      continue;
    }
    const id = String(v.id);
    const at = `view ${id}`;
    if (typeof v.id !== 'string' || v.id === '' || ids.has(v.id))
      out.push(`${at}: id missing or duplicate`);
    ids.add(id);
    if (typeof v.caption !== 'string' || v.caption === '') out.push(`${at}: caption`);
    if (!VIEW_KINDS.includes(v.kind as string)) out.push(`${at}: kind ${String(v.kind)}`);
    if (!ORIENTATIONS.includes(v.orientation as string)) out.push(`${at}: orientation`);
    if (
      !Array.isArray(v.axes) ||
      v.axes.length !== 2 ||
      !v.axes.every((a) => AXES.includes(a as string))
    )
      out.push(`${at}: axes`);
    else if (String(v.axes[0]).replace('-', '') === String(v.axes[1]).replace('-', ''))
      out.push(`${at}: axes must differ`);
    if (v.side !== undefined && !SIDES.includes(v.side as string)) out.push(`${at}: side`);
    if (v.rotation !== undefined && !isNum(v.rotation)) out.push(`${at}: rotation`);
    if (v.kind === 'base' && v.parent !== undefined) out.push(`${at}: a base view has no parent`);
    if (v.kind !== 'base' && typeof v.parent !== 'string') out.push(`${at}: needs a parent`);
    if (v.kind === 'projected' && !SIDES.includes(v.side as string))
      out.push(`${at}: a projected view needs its side`);
    if (v.kind === 'section') {
      const s = v.section;
      if (!isObj(s)) out.push(`${at}: section data missing`);
      else {
        if (typeof s.letter !== 'string' || s.letter === '') out.push(`${at}: section letter`);
        if (!Array.isArray(s.cut) || s.cut.length < 2 || !s.cut.every(isPt))
          out.push(`${at}: section cut needs two or more points`);
        if (s.look !== 'left' && s.look !== 'right') out.push(`${at}: section look`);
      }
    } else if (v.section !== undefined) out.push(`${at}: only a section has section data`);
    if (v.kind === 'detail') {
      const t = v.detail;
      if (!isObj(t) || !isPt(t.centre) || !isNum(t.radius) || typeof t.scale !== 'string')
        out.push(`${at}: detail data`);
    } else if (v.detail !== undefined) out.push(`${at}: only a detail has detail data`);
  }
  for (const v of d.views as Record<string, unknown>[]) {
    if (typeof v.parent === 'string' && !ids.has(v.parent))
      out.push(`view ${String(v.id)}: parent ${v.parent} is not a view`);
  }

  const seen = new Set<string>();
  for (const m of d.dimensions as unknown[]) {
    if (!isObj(m)) {
      out.push('a dimension is not an object');
      continue;
    }
    const name = String(m.name);
    const at = `dimension ${name}`;
    const spec = dimensions[name];
    if (spec === undefined) out.push(`${at}: not a driving dimension of the part`);
    if (seen.has(name)) out.push(`${at}: listed twice`);
    seen.add(name);
    if (!KINDS.includes(m.kind as DrawingDimKind)) out.push(`${at}: kind ${String(m.kind)}`);
    if (!isNum(m.value)) out.push(`${at}: value`);
    else if (spec !== undefined && m.value !== spec.value)
      out.push(`${at}: drawn ${m.value}, the part says ${spec.value}`);
    if (spec !== undefined && m.unit !== spec.unit) out.push(`${at}: unit ${String(m.unit)}`);
    if (typeof m.view !== 'string' || !ids.has(m.view))
      out.push(`${at}: view ${String(m.view)} is not in the drawing`);
    if (m.tolerance !== undefined) {
      const t = m.tolerance;
      if (!isObj(t) || !isNum(t.plus) || !isNum(t.minus) || t.plus < 0 || t.minus < 0)
        out.push(`${at}: tolerance is { plus, minus }, both >= 0`);
    }
    if (m.kind === 'linear') {
      if (m.axis !== 'h' && m.axis !== 'v') out.push(`${at}: linear needs axis h or v`);
      if (!isPt(m.from) || !isPt(m.to)) out.push(`${at}: linear needs from and to`);
    } else {
      if (!isPt(m.at)) out.push(`${at}: needs an anchor point (at)`);
      if (
        (m.kind === 'diameter' || m.kind === 'radius' || m.kind === 'chamfer') &&
        !isNum(m.radius)
      )
        out.push(`${at}: needs the circle radius`);
    }
  }
  for (const name of Object.keys(dimensions))
    if (!seen.has(name)) out.push(`driving dimension ${name} is not on the drawing`);
  return out;
}
