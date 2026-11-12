/**
 * Regen golden (M4, ADR-090): part-level annotations resolved after the walk, with the real
 * kernel. "Edit upstream, check downstream" (PLAN §7.3 item 5) for annotations: values from the
 * source, the nominal or the measurement; needs attention with no value when a reference goes;
 * merged faces reported, never guessed; configurations give their own values; suppression is
 * "not in this configuration"; overrides are by id, so order and deletions never retarget them.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationResolution,
  Configuration,
  EntityRef,
  Feature,
  HoleFeature,
  LinearPatternFeature,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { resolveConfiguration } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import type { RegenOutput } from '../../src/regen/engine';
import { B, bracketDoc } from './bracket';
import {
  type Api,
  describeFailures,
  edgeName,
  extrude,
  fid,
  m3Kernel,
  makeDoc,
  part,
  region,
  Sk,
  side,
  states,
  withParams,
} from './helpers';

const m3 = await m3Kernel();
const note = m3 ? '' : ' — SKIPPED: no kernel with the M3 features (feature check)';

const PART = fid('PART');
const face = (name: string): EntityRef => ({ name, kind: 'face' });
const edge = (name: string): EntityRef => ({ name, kind: 'edge' });
const model = { kind: 'model' } as const;

// The bracket's named geometry (bracket.ts).
const plateBottom = `F${B.E1}:start`;
const plateTop = `F${B.E1}:end`;
const plateLeft = side(B.E1, B.S1, 'L4');
const plateRight = side(B.E1, B.S1, 'L2');
const plateBack = side(B.E1, B.S1, 'L3');
const uprightBack = side(B.E3, B.S3, 'M3');
const uprightTop = `F${B.E3}:end`;
const holeWall = `F${B.E2}:side(S${B.S2}:e(H1))`;
const chamferFace = `F${B.C1}:chamfer(${edgeName(uprightTop, side(B.E3, B.S3, 'M1'))})`;
const filletFace = `F${B.F1}:fillet(${edgeName(plateLeft, side(B.E1, B.S1, 'L1'))})`;

const A = {
  thickness: fid('AN1'),
  width: fid('AN2'),
  hole: fid('AN3'),
  rim: fid('AN4'),
  chamferAngle: fid('AN5'),
  corner: fid('AN6'),
  backFinish: fid('AN7'),
  datumA: fid('AN8'),
  position: fid('AN9'),
  stated: fid('ANA'),
};

/** The id of the H1 diameter dimension in the bracket's hole sketch. */
function holeDiameterId(doc: WrenDoc): string {
  const s = part(doc).features.find((f) => f.id === B.S2) as SketchFeature;
  const c = s.constraints.find((x) => x.kind === 'diameter' && x.curve === 'H1');
  if (!c) throw new Error('no H1 diameter');
  return c.id;
}

function bracketAnnotations(doc: WrenDoc): Annotation[] {
  return [
    {
      id: A.thickness,
      kind: 'linear',
      origin: model,
      refs: [face(plateBottom), face(plateTop)],
      source: { kind: 'featureField', featureId: B.E1, path: '/end/depth' },
    },
    { id: A.width, kind: 'linear', origin: model, refs: [face(plateLeft), face(plateRight)] },
    {
      id: A.hole,
      kind: 'diameter',
      origin: model,
      refs: [face(holeWall)],
      source: { kind: 'sketchDimension', featureId: B.S2, constraintId: holeDiameterId(doc) },
    },
    { id: A.rim, kind: 'diameter', origin: model, refs: [edge(edgeName(plateTop, holeWall))] },
    {
      id: A.chamferAngle,
      kind: 'angle',
      origin: model,
      refs: [face(uprightTop), face(chamferFace)],
    },
    {
      id: A.corner,
      kind: 'radius',
      origin: model,
      refs: [face(filletFace)],
      source: { kind: 'featureField', featureId: B.F1, path: '/radius' },
    },
    {
      id: A.backFinish,
      kind: 'surfaceFinish',
      origin: model,
      refs: [face(uprightBack)],
      process: 'removalRequired',
      requirements: [{ parameter: 'Ra', value: '1.6 µm' }],
    },
    { id: A.datumA, kind: 'datumFeature', origin: model, refs: [face(plateBottom)], label: 'A' },
    {
      id: A.position,
      kind: 'geometricTolerance',
      origin: model,
      refs: [],
      characteristic: 'position',
      zone: { value: '0.1 mm', shape: 'diameter' },
      datums: [{ datums: [{ datum: A.datumA }] }],
      appliesTo: A.hole,
    },
    {
      id: A.stated,
      kind: 'linear',
      origin: model,
      refs: [face(plateBottom), face(plateTop)],
      nominal: '8.02 mm',
    },
  ];
}

function annotated(doc: WrenDoc, anns = bracketAnnotations(doc)): WrenDoc {
  const next = structuredClone(doc);
  part(next).annotations = anns.sort((a, b) => (a.id < b.id ? -1 : 1));
  return next;
}

function withoutFeature(doc: WrenDoc, id: string): WrenDoc {
  const next = structuredClone(doc);
  const p = part(next);
  p.features = p.features.filter((f) => f.id !== id);
  p.rollbackIndex = p.features.length;
  return next;
}

/**
 * Mock of the document package's annotation overrides (`resolveConfiguration` applies them once
 * the document workstream lands; ADR-090 §2.8): by annotation id, `suppressed` and field pointers.
 */
function resolved(doc: WrenDoc, configurationId: string): WrenDoc {
  const out = structuredClone(resolveConfiguration(doc, PART, configurationId).doc);
  const p = part(out);
  const config = part(doc).configurations?.find((c) => c.id === configurationId);
  for (const [id, ov] of Object.entries(config?.annotations ?? {})) {
    const a = p.annotations?.find((x) => x.id === id) as Record<string, unknown> | undefined;
    if (!a) continue;
    if (ov.suppressed !== undefined) a.suppressed = ov.suppressed;
    for (const [pointer, value] of Object.entries(ov.fields ?? {})) {
      const keys = pointer.split('/').slice(1);
      let at = a;
      for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
      at[keys[keys.length - 1] as string] = value;
    }
  }
  return out;
}

function withConfigurations(doc: WrenDoc, configurations: Configuration[]): WrenDoc {
  const next = structuredClone(doc);
  part(next).configurations = configurations;
  return next;
}

/**
 * Deep equality with numbers compared to `digits` decimals (exact geometry: 1e-12 mm), and no
 * extra or missing keys.
 */
function expectClose(actual: unknown, expected: unknown, digits = 12, at = '$'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, at).toBe('number');
    expect(actual as number, at).toBeCloseTo(expected, digits);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), at).toBe(true);
    expect((actual as unknown[]).length, at).toBe(expected.length);
    expected.forEach((x, i) => {
      expectClose((actual as unknown[])[i], x, digits, `${at}[${i}]`);
    });
    return;
  }
  if (expected && typeof expected === 'object') {
    expect(actual !== null && typeof actual === 'object', at).toBe(true);
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    expect(Object.keys(a).sort(), at).toEqual(Object.keys(e).sort());
    for (const k of Object.keys(e)) expectClose(a[k], e[k], digits, `${at}.${k}`);
    return;
  }
  expect(actual, at).toEqual(expected);
}

function byId(r: RegenOutput): Map<string, AnnotationResolution> {
  return new Map((r.annotations ?? []).map((a) => [a.annotationId, a]));
}

function get(r: RegenOutput, id: string): AnnotationResolution {
  const a = byId(r).get(id);
  if (!a) throw new Error(`no resolution for ${id}: ${JSON.stringify(r.annotations)}`);
  return a;
}

describe.skipIf(!m3)(`regen golden (M4): annotations after the walk${note}`, () => {
  const api = m3 as Api;
  const regen = (doc: WrenDoc, extra: Partial<Parameters<Api['regenerate']>[0]> = {}) =>
    api.regenerate({ doc, partId: PART, quality: 'coarse', massProperties: false, ...extra });

  it('linear, diameter, radius, angle, finish, datum and frame resolve with the right values', async () => {
    const doc = annotated(bracketDoc());
    const r = await regen(doc);
    expect(states(r), describeFailures(r)).toEqual(Array(9).fill('ok'));
    expect(r.annotations?.map((a) => a.annotationId)).toEqual(Object.values(A).sort());
    for (const a of r.annotations ?? []) expect(a.state, JSON.stringify(a)).toBe('ok');

    const thickness = get(r, A.thickness);
    expect(thickness.value).toBeCloseTo(8, 9);
    expect(thickness.measured).toBeCloseTo(8, 9);
    expect(thickness.anchors?.map((x) => x?.kind)).toEqual(['plane', 'plane']);
    const bottom = thickness.anchors?.[0];
    expect(bottom?.kind === 'plane' && bottom.normal).toEqual([0, 0, -1]);
    // The plate's bottom outline: the 80 × 50 rectangle with the two rounded front corners.
    if (bottom?.kind !== 'plane') throw new Error('plane anchor');
    const xs = bottom.outline.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(80, 6);
    expect(bottom.outline.every((p) => Math.abs(p[2]) < 1e-9)).toBe(true);

    // Measured with no source: the natural separation of the plate's parallel sides.
    expect(get(r, A.width).value).toBeCloseTo(80, 9);
    expect(get(r, A.width).measured).toBeCloseTo(80, 9);

    // The hole: Ø6 from the sketch's diameter dimension, measured on the cylinder. A diameter of
    // a cylindrical face is anchored by its rim (the drawing dimensions circles): the cut is not a
    // hole feature, so the rim at the far end of the canonical axis (+Z), exact.
    const hole = get(r, A.hole);
    expect(hole.value).toBeCloseTo(6, 9);
    expect(hole.measured).toBeCloseTo(6, 12);
    const holeRim = hole.anchors?.[0];
    if (holeRim?.kind !== 'circle') throw new Error(`rim anchor: ${JSON.stringify(holeRim)}`);
    expectClose(holeRim, { kind: 'circle', center: [20, 21, 8], normal: [0, 0, 1], radius: 3 });

    // The hole's top rim edge: a circle anchor, measured Ø6, exact from `subShapeGeometry`.
    const rim = get(r, A.rim);
    expect(rim.value).toBeCloseTo(6, 12);
    expectClose(rim.anchors?.[0], {
      kind: 'circle',
      center: [20, 21, 8],
      normal: [0, 0, 1],
      radius: 3,
    });

    // 45° between the upright's top and its chamfer (outward normals), exact from the kernel.
    expect(get(r, A.chamferAngle).value).toBeCloseTo(Math.PI / 4, 9);

    // The corner fillet: R5 from the fillet feature, measured on the face.
    expect(get(r, A.corner).value).toBeCloseTo(5, 9);
    expect(get(r, A.corner).measured).toBeCloseTo(5, 9);

    // A stated nominal is the value; the measurement stays the cross-check (valueMismatch).
    expect(get(r, A.stated).value).toBeCloseTo(8.02, 9);
    expect(get(r, A.stated).measured).toBeCloseTo(8, 9);

    // No value on kinds that have none.
    expect(get(r, A.datumA).value).toBeUndefined();
    expect(get(r, A.position).value).toBeUndefined();
  }, 120_000);

  it('a face a boolean merged reports merged (ADR-078), never rebound or guessed', async () => {
    const r = await regen(annotated(bracketDoc()));
    const finish = get(r, A.backFinish);
    expect(finish.state).toBe('ok');
    expect(finish.merged).toEqual([{ path: '/refs/0', name: uprightBack, into: plateBack }]);
    expect(finish.rebound).toBeUndefined();
    expect(finish.anchors?.[0]?.kind).toBe('plane');
  }, 120_000);

  it('deleting the referenced feature: needs attention, the cause, no value', async () => {
    const doc = annotated(bracketDoc());
    await regen(doc);
    const r = await regen(withoutFeature(doc, B.C1));
    const angle = get(r, A.chamferAngle);
    expect(angle.state).toBe('needsAttention');
    expect(angle.value).toBeUndefined();
    expect(angle.unresolved?.map((u) => [u.path, u.reason])).toEqual([['/refs/1', 'missing']]);
    expect(angle.cause).toEqual({ featureId: B.C1, kind: 'deleted' });
    // The resolved ref keeps its anchor; the missing one has none.
    expect(angle.anchors?.[0]?.kind).toBe('plane');
    expect(angle.anchors?.[1]).toBeNull();
    // Nothing else is touched.
    for (const id of [A.thickness, A.width, A.hole, A.corner]) expect(get(r, id).state).toBe('ok');
  }, 120_000);

  it('a deleted source feature or sketch dimension is needs attention with no value', async () => {
    const doc = annotated(bracketDoc());
    const r = await regen(withoutFeature(doc, B.F1));
    const corner = get(r, A.corner);
    expect(corner.state).toBe('needsAttention');
    expect(corner.value).toBeUndefined();
    expect(corner.unresolved?.map((u) => u.path).sort()).toEqual(['/refs/0', '/source']);
    expect(corner.cause).toEqual({ featureId: B.F1, kind: 'deleted' });

    const gone = structuredClone(doc);
    const s2 = part(gone).features.find((f) => f.id === B.S2) as SketchFeature;
    const dim = holeDiameterId(doc);
    s2.constraints = s2.constraints.filter((c) => c.id !== dim);
    const g = await regen(gone);
    const hole = get(g, A.hole);
    expect(hole.state).toBe('needsAttention');
    expect(hole.value).toBeUndefined();
    expect(hole.unresolved?.[0]?.path).toBe('/source');
    expect(hole.cause?.featureId).toBe(B.S2);
    // The frame bound to it needs attention too (never shown as fine).
    expect(get(g, A.position).state).toBe('needsAttention');
  }, 120_000);

  it('editing upstream updates measured and sourced values; no rebound', async () => {
    const doc = annotated(bracketDoc());
    const r = await regen(withParams(doc, { width: '120 mm', thickness: '10 mm', hole_d: '7 mm' }));
    expect(states(r), describeFailures(r)).toEqual(Array(9).fill('ok'));
    expect(get(r, A.width).value).toBeCloseTo(120, 9);
    expect(get(r, A.thickness).value).toBeCloseTo(10, 9);
    expect(get(r, A.hole).value).toBeCloseTo(7, 9);
    expect(get(r, A.hole).measured).toBeCloseTo(7, 9);
    for (const a of r.annotations ?? []) expect(a.rebound, a.annotationId).toBeUndefined();
  }, 120_000);

  it('a configuration with a different depth gives a different value', async () => {
    const C = fid('CFG1');
    const doc = withConfigurations(annotated(bracketDoc()), [
      { id: C, name: 'Thick', features: { [B.E1]: { fields: { '/end/depth': '12 mm' } } } },
    ]);
    const main = await regen(doc);
    const thick = await regen(resolved(doc, C), { slot: `config:${C}` });
    expect(states(thick), describeFailures(thick)).toEqual(Array(9).fill('ok'));
    expect(get(main, A.thickness).value).toBeCloseTo(8, 9);
    expect(get(thick, A.thickness).value).toBeCloseTo(12, 9);
    expect(get(thick, A.thickness).measured).toBeCloseTo(12, 9);
    // The main slot is undisturbed by the configuration build.
    const again = await regen(doc);
    expect(get(again, A.thickness).value).toBeCloseTo(8, 9);
  }, 120_000);

  it('a suppressed source, ref feature or annotation is suppressed, not needs attention', async () => {
    const C = fid('CFG2');
    const doc = withConfigurations(annotated(bracketDoc()), [
      {
        id: C,
        name: 'Sharp, no chamfer',
        features: { [B.F1]: { suppressed: true }, [B.C1]: { suppressed: true } },
        annotations: { [A.width]: { suppressed: true } },
      },
    ]);
    const r = await regen(resolved(doc, C), { slot: `config:${C}` });
    const corner = get(r, A.corner);
    expect(corner.state).toBe('suppressed');
    expect(corner.value).toBeUndefined();
    expect(corner.cause).toEqual({ featureId: B.F1, kind: 'suppressed' });
    // A ref-only annotation whose ref came from a suppressed feature.
    const angle = get(r, A.chamferAngle);
    expect(angle.state).toBe('suppressed');
    expect(angle.cause).toEqual({ featureId: B.C1, kind: 'suppressed' });
    // Suppressed in the configuration itself.
    expect(get(r, A.width)).toEqual({ annotationId: A.width, state: 'suppressed' });
    expect(get(r, A.thickness).state).toBe('ok');
  }, 120_000);

  it('M3.7 finding: reordering or deleting annotations never retargets an override', async () => {
    const C = fid('CFG3');
    const base = annotated(bracketDoc());
    const overrides: Configuration['annotations'] = {
      [A.stated]: { fields: { '/nominal': '8.05 mm' } },
      [A.width]: { suppressed: true },
    };
    const doc = withConfigurations(base, [{ id: C, name: 'Tight', annotations: overrides }]);
    const slot = `config:${C}` as const;
    const first = await regen(resolved(doc, C), { slot });
    expect(get(first, A.stated).value).toBeCloseTo(8.05, 9);
    expect(get(first, A.width).state).toBe('suppressed');

    // Reversed array order (order carries no meaning): every resolution is the same, by id.
    const reversed = structuredClone(doc);
    part(reversed).annotations?.reverse();
    const r = await regen(resolved(reversed, C), { slot });
    expect(r.annotations).toEqual(first.annotations);

    // Deleting the annotation listed before the overridden ones moves nothing onto another.
    const deleted = structuredClone(doc);
    part(deleted).annotations = part(deleted).annotations?.filter((a) => a.id !== A.thickness);
    const d = await regen(resolved(deleted, C), { slot });
    expect(byId(d).has(A.thickness)).toBe(false);
    expect(get(d, A.stated).value).toBeCloseTo(8.05, 9);
    expect(get(d, A.width).state).toBe('suppressed');
    expect(get(d, A.hole).value).toBeCloseTo(6, 9);
    expect(get(d, A.datumA).state).toBe('ok');
    for (const id of [A.hole, A.rim, A.chamferAngle, A.corner, A.position]) {
      expect(get(d, id)).toEqual(get(first, id));
    }

    // Reordering features changes no annotation either (refs are names, overrides are ids).
    const moved = structuredClone(doc);
    const fs = part(moved).features;
    const [f1, f2] = [fs[6] as Feature, fs[7] as Feature];
    fs[6] = f2;
    fs[7] = f1;
    const m = await regen(resolved(moved, C), { slot });
    expect(states(m), describeFailures(m)).toEqual(Array(9).fill('ok'));
    expect(get(m, A.stated).value).toBeCloseTo(8.05, 9);
    expect(get(m, A.width).state).toBe('suppressed');
  }, 120_000);

  it('an unbound datum letter needs attention; the frame is never bound by guessing', async () => {
    const doc = annotated(bracketDoc());
    const frame = part(doc).annotations?.find((a) => a.id === A.position);
    if (frame?.kind !== 'geometricTolerance') throw new Error('frame');
    // `BB` looks like a body tag (`B<id>`): a letter is never read as a persistent name.
    frame.datums = [{ datums: [{ label: 'A' }] }, { datums: [{ label: 'BB' }] }];
    const r = await regen(doc);
    const f = get(r, A.position);
    expect(f.state).toBe('needsAttention');
    expect(f.value).toBeUndefined();
    expect(f.unresolved?.map((u) => u.path)).toEqual(['/datums/0/datums/0', '/datums/1/datums/0']);
    expect(f.unresolved?.every((u) => u.cause === undefined)).toBe(true);
    expect(f.cause).toBeUndefined();
  }, 120_000);

  it('a datum on a feature of size (appliesTo, ADR-094): ok on its dimension; a missing one needs attention; it follows its dimension', async () => {
    const doc = annotated(bracketDoc());
    const anns = part(doc).annotations ?? [];
    const width: Annotation = {
      id: fid('ANB'),
      kind: 'datumFeature',
      origin: model,
      refs: [],
      label: 'B',
      appliesTo: A.width,
    };
    const gone: Annotation = { ...width, id: fid('ANC'), label: 'C', appliesTo: fid('NOPE') };
    part(doc).annotations = [...anns, width, gone].sort((a, b) => (a.id < b.id ? -1 : 1));
    const r = await regen(doc);
    const w = get(r, width.id);
    expect(w.state, JSON.stringify(w)).toBe('ok');
    expect(w.value).toBeUndefined();
    // No refs of its own: the layout reads the width dimension's anchors.
    expect(w.anchors).toBeUndefined();
    const g = get(r, gone.id);
    expect(g.state).toBe('needsAttention');
    expect(g.unresolved?.map((u) => u.path)).toEqual(['/appliesTo']);
    // The width dimension needs attention: so does its datum, with the reason.
    const broken = structuredClone(doc);
    const dim = part(broken).annotations?.find((a) => a.id === A.width);
    if (!dim) throw new Error('width');
    dim.refs = [face(plateLeft), face('F404:nowhere')];
    const r2 = await regen(broken);
    expect(get(r2, A.width).state).toBe('needsAttention');
    const w2 = get(r2, width.id);
    expect(w2.state).toBe('needsAttention');
    expect(JSON.stringify(w2)).toContain('The dimension this datum applies to needs attention');
  }, 120_000);

  it('annotations never touch feature cache keys, and run only when asked', async () => {
    const plain = bracketDoc();
    await regen(plain);
    const r = await regen(annotated(plain));
    expect(r.cache).toEqual({ hits: 9, misses: 0 });
    expect(r.annotations).toHaveLength(Object.keys(A).length);
    const off = await regen(annotated(plain), { annotations: false });
    expect(off.annotations).toBeUndefined();
    const none = await regen(plain);
    expect(none.annotations).toBeUndefined();
    const asked = await regen(plain, { annotations: true });
    expect(asked.annotations).toEqual([]);
  }, 120_000);

  it('an upstream edit that removes the entity names the change as the cause', async () => {
    const H2 = fid('AN11');
    const wall2 = `F${B.E2}:side(S${B.S2}:e(H2))`;
    const doc = annotated(bracketDoc(), [
      { id: H2, kind: 'diameter', origin: model, refs: [face(wall2)] },
    ]);
    const before = await regen(doc);
    expect(get(before, H2).value).toBeCloseTo(6, 9);
    // The hole cut now takes only H1: H2's wall is gone because the cut changed.
    const edited = structuredClone(doc);
    const cut = part(edited).features.find((f) => f.id === B.E2);
    if (cut?.type !== 'extrude') throw new Error('cut');
    cut.profile = [region(B.S2, 'H1')];
    const r = await regen(edited);
    const a = get(r, H2);
    expect(a.state).toBe('needsAttention');
    expect(a.value).toBeUndefined();
    expect(a.cause).toMatchObject({ featureId: B.E2, kind: 'changed' });
    // Unchanged again: the cause is carried over (rule 3), not lost.
    const again = await regen(edited);
    expect(get(again, H2).cause).toEqual(a.cause);
  }, 120_000);

  it('an unchanged regen reuses the resolutions: no kernel calls (cheap while a drawing is open)', async () => {
    const doc = annotated(bracketDoc());
    const a = await regen(doc);
    const core = (api.engine as unknown as { core: { kernel: Record<string, unknown> } }).core;
    const k = core.kernel as {
      measureShapes: (...args: unknown[]) => Promise<unknown>;
      projectFaceOutline?: (...args: unknown[]) => Promise<unknown>;
      subShapeGeometry?: (...args: unknown[]) => Promise<unknown>;
    };
    const measure = k.measureShapes;
    const outline = k.projectFaceOutline;
    const exact = k.subShapeGeometry;
    let calls = 0;
    k.measureShapes = (...args) => {
      calls++;
      return measure(...args);
    };
    if (outline) {
      k.projectFaceOutline = (...args) => {
        calls++;
        return outline(...args);
      };
    }
    if (exact) {
      k.subShapeGeometry = (...args) => {
        calls++;
        return exact(...args);
      };
    }
    try {
      const b = await regen(doc);
      expect(b.annotations).toEqual(a.annotations);
      expect(calls).toBe(0);
      // An annotation-only edit re-resolves that annotation from the per-handle memo: still none.
      const edited = structuredClone(doc);
      const stated = part(edited).annotations?.find((x) => x.id === A.stated);
      if (stated?.kind !== 'linear') throw new Error('stated');
      stated.nominal = '8.1 mm';
      const c = await regen(edited);
      expect(get(c, A.stated).value).toBeCloseTo(8.1, 9);
      expect(calls).toBe(0);
    } finally {
      k.measureShapes = measure;
      if (outline) k.projectFaceOutline = outline;
      if (exact) k.subShapeGeometry = exact;
    }
  }, 120_000);

  describe('exact geometry (subShapeGeometry)', () => {
    type CountedKernel = Record<string, (...args: unknown[]) => Promise<unknown>>;
    const kernelOf = () =>
      (api.engine as unknown as { core: { kernel: CountedKernel } }).core.kernel;

    /** Runs `fn` counting the calls of the named kernel entries. */
    async function counting<T>(names: string[], fn: () => Promise<T>) {
      const k = kernelOf();
      const saved = new Map(names.map((n) => [n, k[n]]));
      const calls: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
      for (const n of names) {
        const f = saved.get(n);
        if (!f) continue;
        k[n] = (...args) => {
          calls[n] = (calls[n] ?? 0) + 1;
          return f(...args);
        };
      }
      try {
        return { value: await fn(), calls };
      } finally {
        for (const [n, f] of saved) if (f) k[n] = f;
      }
    }

    it('round and straight refs cost one exact call each, no probes', async () => {
      const doc = annotated(bracketDoc());
      // New shapes (an upstream edit), so nothing is memoised per handle.
      const edited = withParams(doc, { hole_d: '6.5 mm' });
      const { value: r, calls } = await counting(['measureShapes', 'subShapeGeometry'], () =>
        regen(edited),
      );
      for (const a of r.annotations ?? []) expect(a.state, a.annotationId).toBe('ok');
      // One call per sub-shape: the hole wall, its rim edge (shared with the wall's rim search),
      // the corner fillet face and its rim arc. Planes need none (fingerprint centroid and
      // outward normal). The probes take 85 measurements for the same refs (next test).
      expect(calls.measureShapes).toBe(0);
      expect(calls.subShapeGeometry).toBe(4);
      expect(get(r, A.hole).measured).toBeCloseTo(6.5, 12);
      expect(get(r, A.rim).measured).toBeCloseTo(6.5, 12);
      // The corner fillet: a radius of a quarter cylinder is its rim arc at the top of the plate,
      // with the arc's ends (exact, in key order).
      expectClose(get(r, A.corner).anchors?.[0], {
        kind: 'circle',
        center: [5, 5, 8],
        normal: [0, 0, 1],
        radius: 5,
        start: [0, 5, 8],
        end: [5, 0, 8],
      });
      expect(get(r, A.corner).measured).toBeCloseTo(5, 12);
    }, 120_000);

    it('chamfer faces have outward normals now (planeOf fix): 45° and an outward plane anchor', async () => {
      const r = await regen(annotated(bracketDoc()));
      const angle = get(r, A.chamferAngle);
      expect(angle.value).toBeCloseTo(Math.PI / 4, 12);
      const chamfer = angle.anchors?.[1];
      if (chamfer?.kind !== 'plane') throw new Error(`plane anchor: ${JSON.stringify(chamfer)}`);
      // The upright's top front edge (y = 42, z = 48) chamfered 2 mm: outward is −Y +Z.
      expectClose(chamfer.normal, [0, -Math.SQRT1_2, Math.SQRT1_2]);
      // Its outline is the 80 × 2√2 rectangle, in order (the outline chains the face's wire).
      expectClose(
        chamfer.outline,
        [
          [0, 44, 48],
          [0, 42, 46],
          [80, 42, 46],
          [80, 44, 48],
        ],
        9,
      );
    }, 120_000);

    it('a kernel build without subShapeGeometry gives the same anchors and values by probing', async () => {
      const doc = annotated(bracketDoc());
      const exact = await regen(doc);
      const k = kernelOf();
      const saved = k.subShapeGeometry;
      delete k.subShapeGeometry;
      try {
        // Another slot: its own result cache, so new handles and no per-handle memo.
        const C = fid('CFGPROBE');
        const { value: probed, calls } = await counting(['measureShapes'], () =>
          regen(doc, { slot: `config:${C}` }),
        );
        // 85 measurements for the four sub-shapes the exact path reads with 4 calls.
        expect(calls.measureShapes).toBeGreaterThan(40);
        const strip = (rs: AnnotationResolution[] | undefined) =>
          (rs ?? []).map((a) => {
            // The probes find no arc ends for a partial cylinder (exact path only).
            const anchors = a.anchors?.map((x) =>
              x?.kind === 'circle' ? { ...x, start: undefined, end: undefined } : x,
            );
            return JSON.parse(JSON.stringify({ ...a, anchors }));
          });
        expectClose(strip(probed.annotations), strip(exact.annotations), 6);
      } finally {
        if (saved) k.subShapeGeometry = saved;
      }
    }, 120_000);
  });

  describe('hole callouts', () => {
    const S1 = fid('HS1');
    const E1 = fid('HE1');
    const S2 = fid('HS2');
    const H = fid('HH');
    const P = fid('HP');
    const CALL = fid('HCALL');
    const top = `F${E1}:end`;
    const bottom = `F${E1}:start`;
    /**
     * An 80 × 50 × 10 plate with an ISO M6 hole at (15, 25) patterned `n` times along X. `patch`
     * edits the hole; `fromBelow` drills it from the bottom face (points sketched on origin:XY,
     * which is that face's plane).
     */
    function holeDoc(n: string, patch?: (h: HoleFeature) => void, fromBelow = false): WrenDoc {
      const s1 = new Sk();
      const r1 = s1.rect('p', 'L', 0, 0, 80, 50, '80 mm', '50 mm');
      s1.geo({ kind: 'fix', entity: r1.a });
      const s2 = new Sk();
      s2.point('p', 15, 25);
      s2.dim({ kind: 'hDistance', a: '@origin', b: 'p' }, '15 mm');
      s2.dim({ kind: 'vDistance', a: '@origin', b: 'p' }, '25 mm');
      const hole: HoleFeature = {
        id: H,
        type: 'hole',
        name: 'Hole',
        suppressed: false,
        points: [{ name: `S${S2}:p(p)`, kind: 'vertex' }],
        face: face(fromBelow ? bottom : top),
        standard: 'ISO',
        kind: 'simple',
        size: 'M6',
        fit: 'normal',
        end: { kind: 'throughAll' },
      };
      patch?.(hole);
      const pattern: LinearPatternFeature = {
        id: P,
        type: 'linearPattern',
        name: 'Holes',
        suppressed: false,
        source: { kind: 'features', features: [H] },
        direction: edge('origin:X'),
        reverse: false,
        count: n,
        spacing: '20 mm',
      };
      const doc = makeDoc(
        {},
        [
          s1.feature(S1),
          extrude(E1, [region(S1, 'L1,L2,L3,L4')], '10 mm'),
          s2.feature(S2, fromBelow ? 'origin:XY' : face(top), 'Hole points'),
          hole,
          pattern,
        ],
        PART,
      );
      part(doc).annotations = [
        {
          id: CALL,
          kind: 'holeCallout',
          origin: model,
          refs: [],
          source: { kind: 'feature', featureId: H },
        },
      ];
      return doc;
    }

    it('instances include pattern copies; value from the hole, measured on the bore', async () => {
      const r = await regen(holeDoc('3'));
      expect(states(r), describeFailures(r)).toEqual(Array(5).fill('ok'));
      const c = get(r, CALL);
      expect(c.state).toBe('ok');
      expect(c.value).toBeCloseTo(6.6, 9); // ISO M6 normal clearance
      expect(c.measured).toBeCloseTo(6.6, 9);
      const wall = `F${H}:hole(S${S2}:p(p)):wall`;
      expect(c.instances?.map((x) => x.name)).toEqual([
        wall,
        `F${P}:inst1(${wall})`,
        `F${P}:inst2(${wall})`,
      ]);
      const xs = c.instances?.map((x) => x.fingerprint?.centroid[0]);
      expect(xs?.map((x) => Math.round(x ?? Number.NaN))).toEqual([15, 35, 55]);

      const four = await regen(holeDoc('4'));
      expect(get(four, CALL).instances).toHaveLength(4);
    }, 120_000);

    // ADR-092 proposal 1: the callout's anchor is the first instance's rim at the entry face, so
    // the drawing needs no mesh workaround. Exact (`subShapeGeometry`); the normal points out.
    it('the anchor is the first instance’s rim at the entry face (through hole from the top)', async () => {
      const c = get(await regen(holeDoc('3')), CALL);
      expect(c.anchors).toHaveLength(1);
      expectClose(c.anchors?.[0], {
        kind: 'circle',
        center: [15, 25, 10],
        normal: [0, 0, 1],
        radius: 3.3,
      });
    }, 120_000);

    it('a through hole drilled from the bottom face has its entry rim there', async () => {
      const r = await regen(holeDoc('3', undefined, true));
      expect(states(r), describeFailures(r)).toEqual(Array(5).fill('ok'));
      const c = get(r, CALL);
      expect(c.state).toBe('ok');
      expectClose(c.anchors?.[0], {
        kind: 'circle',
        center: [15, 25, 0],
        normal: [0, 0, -1],
        radius: 3.3,
      });
    }, 120_000);

    it('a blind counterbored hole: the counterbore’s rim; a countersunk one: the outer rim', async () => {
      const cbore = await regen(
        holeDoc('2', (h) => {
          h.kind = 'counterbore';
          h.end = { kind: 'blind', depth: '8 mm' };
          h.counterbore = { diameter: '11 mm', depth: '4 mm' };
        }),
      );
      expect(states(cbore), describeFailures(cbore)).toEqual(Array(5).fill('ok'));
      expectClose(get(cbore, CALL).anchors?.[0], {
        kind: 'circle',
        center: [15, 25, 10],
        normal: [0, 0, 1],
        radius: 5.5,
      });
      // The bore itself is still what is measured.
      expect(get(cbore, CALL).measured).toBeCloseTo(6.6, 12);

      const csink = await regen(
        holeDoc('2', (h) => {
          h.kind = 'countersink';
          h.countersink = { diameter: '12 mm', angle: '90 deg' };
        }),
      );
      expect(states(csink), describeFailures(csink)).toEqual(Array(5).fill('ok'));
      expectClose(get(csink, CALL).anchors?.[0], {
        kind: 'circle',
        center: [15, 25, 10],
        normal: [0, 0, 1],
        radius: 6,
      });
    }, 120_000);

    it('a diameter on a blind hole’s wall is anchored at the entry, not the bottom', async () => {
      const D = fid('HDIA');
      const doc = holeDoc('2', (h) => {
        h.end = { kind: 'blind', depth: '6 mm' };
      });
      const wall = `F${H}:hole(S${S2}:p(p)):wall`;
      part(doc).annotations?.push({ id: D, kind: 'diameter', origin: model, refs: [face(wall)] });
      const r = await regen(doc);
      expect(get(r, D).value).toBeCloseTo(6.6, 12);
      expectClose(get(r, D).anchors?.[0], {
        kind: 'circle',
        center: [15, 25, 10],
        normal: [0, 0, 1],
        radius: 3.3,
      });
    }, 120_000);

    it('a suppressed hole makes its callout suppressed', async () => {
      const doc = holeDoc('3');
      const h = part(doc).features.find((f) => f.id === H) as HoleFeature;
      h.suppressed = true;
      const r = await regen(doc);
      expect(get(r, CALL)).toEqual({
        annotationId: CALL,
        state: 'suppressed',
        cause: { featureId: H, kind: 'suppressed' },
      });
    }, 120_000);
  });

  // ADR-092 proposal 2: anchors of refs that are not annotations yet, for the drawing import's
  // promoted fillet, chamfer and revolve values (packages/drawing `ImportInput.resolveAnchor`).
  describe('anchor queries (annotationAnchors)', () => {
    it('a fillet radius: the rim arc of the fillet face; plain: its axis', async () => {
      const doc = bracketDoc();
      await regen(doc);
      const q = await api.annotationAnchors(PART, [
        { ref: face(filletFace), annotationKind: 'radius' },
        { ref: face(filletFace) },
        { ref: face(filletFace), at: 'center' },
      ]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      const [rim, axis, centre] = q.value;
      expectClose(rim, {
        anchor: {
          kind: 'circle',
          center: [5, 5, 8],
          normal: [0, 0, 1],
          radius: 5,
          start: [0, 5, 8],
          end: [5, 0, 8],
        },
      });
      expectClose(axis, {
        anchor: { kind: 'axis', origin: [5, 5, 0], direction: [0, 0, 1], extent: [0, 8] },
      });
      expectClose(centre, { anchor: { kind: 'point', at: [5, 5, 4] } });
    }, 120_000);

    it('a chamfer: its face as an outward plane with its outline', async () => {
      await regen(bracketDoc());
      const q = await api.annotationAnchors(PART, [
        { ref: face(chamferFace), annotationKind: 'chamfer' },
      ]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      const a = q.value[0]?.anchor;
      if (a?.kind !== 'plane') throw new Error(`plane anchor: ${JSON.stringify(a)}`);
      expectClose(a.normal, [0, -Math.SQRT1_2, Math.SQRT1_2]);
      expectClose(a.origin, [40, 43, 47]);
      // 80 mm along X by 2√2 across.
      const xs = a.outline.map((p) => p[0]);
      expect(Math.min(...xs)).toBeCloseTo(0, 9);
      expect(Math.max(...xs)).toBeCloseTo(80, 9);
      for (const p of a.outline) {
        expect(p[1] - 42).toBeCloseTo(p[2] - 46, 9);
        expect(p[1]).toBeGreaterThan(42 - 1e-9);
        expect(p[1]).toBeLessThan(44 + 1e-9);
      }
      expect(q.value[0]?.unresolved).toBeUndefined();
    }, 120_000);

    it('a revolve angle: start and end faces; the angle is the supplement of the normals’', async () => {
      const SK = fid('QRS');
      const RV = fid('QRV');
      const ANG = fid('QANG');
      const s = new Sk();
      s.rect('p', 'L', 10, 0, 20, 5);
      for (const p of ['pa', 'pb', 'pc', 'pd']) s.geo({ kind: 'fix', entity: p });
      const doc = makeDoc(
        {},
        [
          s.feature(SK, 'origin:XZ'),
          {
            id: RV,
            type: 'revolve',
            name: 'Revolve',
            suppressed: false,
            profile: [region(SK, 'L1,L2,L3,L4')],
            axis: { name: 'origin:Z', kind: 'edge' },
            angle: '120 deg',
            direction: 'normal',
            op: 'new',
          },
        ],
        PART,
      );
      const refs = [face(`F${RV}:start`), face(`F${RV}:end`)];
      // What the import would promote, with `measure: 'supplement'` (see the ADR-090 amendment).
      part(doc).annotations = [
        {
          id: ANG,
          kind: 'angle',
          origin: model,
          refs,
          measure: 'supplement',
          source: { kind: 'featureField', featureId: RV, path: '/angle' },
        },
      ];
      const r = await regen(doc);
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
      const q = await api.annotationAnchors(
        PART,
        refs.map((ref) => ({ ref, annotationKind: 'angle' as const })),
      );
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      const [p0, p1] = q.value.map((x) => x.anchor);
      if (p0?.kind !== 'plane' || p1?.kind !== 'plane') throw new Error('plane anchors');
      // Both faces contain the Z axis: normals in XY, outlines from radius 10 to 20.
      expect(p0.normal[2]).toBeCloseTo(0, 12);
      expect(p1.normal[2]).toBeCloseTo(0, 12);
      const between = Math.acos(p0.normal[0] * p1.normal[0] + p0.normal[1] * p1.normal[1]);
      expect(between).toBeCloseTo(Math.PI / 3, 12);
      expect(Math.PI - between).toBeCloseTo((2 * Math.PI) / 3, 12);
      // The start face is the sketch region on XZ.
      for (const p of p0.outline) expect(p[1]).toBeCloseTo(0, 9);
      // The anchors are the resolution's own.
      expectClose(get(r, ANG).anchors, [p0, p1]);
      expect(get(r, ANG).value).toBeCloseTo((2 * Math.PI) / 3, 12);
      expect(get(r, ANG).measured).toBeCloseTo((2 * Math.PI) / 3, 12);
    }, 120_000);

    it('a hole wall for a callout: the entry rim, as the callout resolves it', async () => {
      // The bracket's holes are cuts, not hole features: the rim at the canonical far end.
      await regen(bracketDoc());
      const q = await api.annotationAnchors(PART, [
        { ref: face(holeWall), annotationKind: 'diameter' },
      ]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      expectClose(q.value[0], {
        anchor: { kind: 'circle', center: [20, 21, 8], normal: [0, 0, 1], radius: 3 },
      });
    }, 120_000);

    it('unresolved refs: no anchor, never a guess; the structural cause', async () => {
      const doc = bracketDoc();
      await regen(withoutFeature(doc, B.C1));
      const q = await api.annotationAnchors(PART, [
        { ref: face(plateTop) },
        { ref: face(chamferFace), annotationKind: 'chamfer' },
      ]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      expect(q.value[0]?.anchor?.kind).toBe('plane');
      expect(q.value[1]).toEqual({
        anchor: null,
        unresolved: {
          path: '/1',
          ref: face(chamferFace),
          reason: 'missing',
          cause: { featureId: B.C1, kind: 'deleted' },
        },
      });

      // Suppressed in a configuration slot: the cause says so (not in this configuration).
      const C = fid('CFGQ');
      const configured = withConfigurations(doc, [
        { id: C, name: 'No fillet', features: { [B.F1]: { suppressed: true } } },
      ]);
      await regen(resolved(configured, C), { slot: `config:${C}` });
      const s = await api.annotationAnchors(
        PART,
        [{ ref: face(filletFace), annotationKind: 'radius' }],
        `config:${C}`,
      );
      if (!s.ok) throw new Error(JSON.stringify(s.error));
      expect(s.value[0]?.anchor).toBeNull();
      expect(s.value[0]?.unresolved?.cause).toEqual({ featureId: B.F1, kind: 'suppressed' });
    }, 120_000);

    it('a merged face is reported merged and anchored on the face it merged into', async () => {
      await regen(bracketDoc());
      const q = await api.annotationAnchors(PART, [{ ref: face(uprightBack) }]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      expect(q.value[0]?.merged).toEqual({ path: '/0', name: uprightBack, into: plateBack });
      expect(q.value[0]?.anchor?.kind).toBe('plane');
    }, 120_000);

    it('queries read the slot and never change it; refused before a regen', async () => {
      const doc = annotated(bracketDoc());
      const a = await regen(doc);
      const q = await api.annotationAnchors(PART, [
        { ref: face(filletFace), annotationKind: 'radius' },
        { ref: face(`F${fid('GONE')}:end`) },
      ]);
      expect(q.ok).toBe(true);
      const b = await regen(doc);
      expect(b.cache.misses).toBe(0);
      expect(b.annotations).toEqual(a.annotations);

      const none = await api.annotationAnchors(fid('NOPART'), [{ ref: face(plateTop) }]);
      expect(none.ok).toBe(false);
      if (!none.ok) expect(none.error.code).toBe('INVALID_INPUT');
      const bad = await api.annotationAnchors(PART, [], 'nope' as never);
      expect(bad.ok).toBe(false);
    }, 120_000);
  });
});
