/**
 * Regen golden (M4 gate, second round): annotations on the certification reference parts
 * (packages/test-fixtures `buildDoc`), with the real kernel. The refs are the ones "Import model
 * annotations" promotes (packages/drawing promote.ts), written out here so this suite does not
 * depend on the drawing package.
 *
 *  - GAP-ORIGIN: sketch dimensions from the sketch origin (`S…:p(@origin)`), its axes (`@x`,
 *    `@y`) and stored construction points resolve against the sketch's final frame; a sketch that
 *    is suppressed or fails gives its cause. The anchors for picking origins and centre lines.
 *  - GAP-EXTRUDE-DEPTH: a cut's depth from its placement face to its floor (rp01 pocket), an add's
 *    end face opened by a shell (rp05: the rim), split into coplanar pieces (rp06), or carried
 *    through a Boolean (rp04).
 *  - Counts: `count` for `text.count`, the instances that exist (skipped pattern instances are not
 *    holes): rp08 tapped holes, rp09 bolt holes, rp10 slots and the mirrored ear hole.
 *  - M4.1 (ADR-095), the drawing pick gaps on the modeling side: construction refs (origin axes
 *    spanning the part, plane, axis and point features, sketch points) and pitch circles
 *    (`F<pattern>:pitch`); faces measured in section views (natural separations, draft angles at
 *    `axis`); extremes (`min` / `max`); torus radii.
 *
 * Edit upstream, check downstream: each case is re-run at a CSWP stage of the part.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationAnchor,
  AnnotationResolution,
  DimensionConstraint,
  EntityRef,
  Id,
  SketchFeature,
  Vec3,
  WrenDoc,
} from '@wren-cad/contracts';
import {
  baselineDims,
  buildDoc,
  PARTS,
  type PartDef,
  stageDoc,
} from '@wren-cad/test-fixtures/reference-parts';
import { describe, expect, it } from 'vitest';
import type { RegenOutput } from '../../src/regen/engine';
import { type Api, describeFailures, fid, m3Kernel, part, states } from './helpers';

const m3 = await m3Kernel();
const note = m3 ? '' : ' — SKIPPED: no kernel with the M3 features (feature check)';

const model = { kind: 'model' } as const;
const face = (name: string): EntityRef => ({ name, kind: 'face' });

function partDef(id: string): PartDef {
  const p = PARTS.find((x) => x.id.startsWith(id));
  if (!p) throw new Error(`no reference part ${id}`);
  return p;
}

/** The feature id of a reference part's step (`buildDoc` makes one feature per step). */
function stepId(p: PartDef, doc: WrenDoc, step: string): Id {
  const dims = baselineDims(p);
  const i = p.steps((n) => dims[n] as number).findIndex((s) => s.id === step);
  const f = part(doc).features[i];
  if (i < 0 || !f) throw new Error(`${p.id}: no step ${step}`);
  return f.id;
}

/** The id of a driving sketch dimension `kind` from `a` to `b` in sketch `sk`. */
function dimId(doc: WrenDoc, sk: Id, kind: DimensionConstraint['kind'], a: Id, b: Id): Id {
  const s = part(doc).features.find((f) => f.id === sk) as SketchFeature;
  const c = s.constraints.find(
    (x) => x.kind === kind && 'a' in x && x.a === a && 'b' in x && x.b === b,
  );
  if (!c) throw new Error(`no ${kind} ${a}→${b} in ${sk}`);
  return c.id;
}

/** The baseline document's parameters changed as at a stage (same ids, same annotations). */
function toStage(p: PartDef, doc: WrenDoc, set: Record<string, number>): WrenDoc {
  const next = structuredClone(doc);
  next.params = stageDoc(p, set).params;
  return next;
}

function get(r: RegenOutput, id: string): AnnotationResolution {
  const a = r.annotations?.find((x) => x.annotationId === id);
  if (!a) throw new Error(`no resolution for ${id}: ${JSON.stringify(r.annotations)}`);
  return a;
}

function close(actual: Vec3 | undefined, expected: Vec3, digits = 9): void {
  expect(actual, JSON.stringify(actual)).toBeDefined();
  (actual as Vec3).forEach((v, i) => {
    expect(v, `${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`).toBeCloseTo(
      expected[i] as number,
      digits,
    );
  });
}

function point(a: AnnotationAnchor | null | undefined): Vec3 {
  if (a?.kind !== 'point') throw new Error(`point anchor: ${JSON.stringify(a)}`);
  return a.at;
}

function line(a: AnnotationAnchor | null | undefined): { a: Vec3; b: Vec3 } {
  if (a?.kind !== 'line') throw new Error(`line anchor: ${JSON.stringify(a)}`);
  return a;
}

function planeZ(a: AnnotationAnchor | null | undefined): number {
  if (a?.kind !== 'plane') throw new Error(`plane anchor: ${JSON.stringify(a)}`);
  expect(Math.abs(a.normal[2])).toBeCloseTo(1, 12);
  return a.origin[2];
}

describe.skipIf(!m3)(`regen golden (M4 gate): reference-part annotations${note}`, () => {
  const api = m3 as Api;
  const regen = async (doc: WrenDoc) => {
    const r = await api.regenerate({
      doc,
      partId: part(doc).id,
      quality: 'coarse',
      massProperties: false,
    });
    return r;
  };
  const allOk = (r: RegenOutput) =>
    expect(states(r), describeFailures(r)).toEqual(r.features.map(() => 'ok'));

  // -------------------------------------------------------------------------------------------
  // GAP-ORIGIN
  // -------------------------------------------------------------------------------------------

  describe('GAP-ORIGIN: sketch origins, axes and construction points (rp01)', () => {
    const P = partDef('rp01');
    const A = {
      holeX: fid('RAOX'),
      holeY: fid('RAOY'),
      fromAxis: fid('RAOA'),
      fromXAxis: fid('RAOB'),
      half: fid('RAOH'),
      pocketY: fid('RAOP'),
    };

    function annotated(): { doc: WrenDoc; holes: Id; base: Id; pocket: Id } {
      const doc = buildDoc(P);
      const holes = stepId(P, doc, 'holes_sk');
      const base = stepId(P, doc, 'base_sk');
      const pocket = stepId(P, doc, 'pocket_sk');
      const pt = (sk: Id, id: string): EntityRef => ({ name: `S${sk}:p(${id})`, kind: 'vertex' });
      const ax = (sk: Id, id: string): EntityRef => ({ name: `S${sk}:e(${id})`, kind: 'edge' });
      const src = (sk: Id, kind: 'hDistance' | 'vDistance', a: Id, b: Id) => ({
        kind: 'sketchDimension' as const,
        featureId: sk,
        constraintId: dimId(doc, sk, kind, a, b),
      });
      const anns: Annotation[] = [
        // As Import promotes them: the builder's construction origin point `o`.
        {
          id: A.holeX,
          kind: 'linear',
          origin: model,
          refs: [pt(holes, 'o'), pt(holes, 'H1c')],
          direction: [1, 0, 0],
          source: src(holes, 'hDistance', 'o', 'H1c'),
        },
        {
          id: A.holeY,
          kind: 'linear',
          origin: model,
          refs: [pt(holes, 'o'), pt(holes, 'H1c')],
          direction: [0, 1, 0],
          source: src(holes, 'vDistance', 'o', 'H1c'),
        },
        // From the sketch's own reference geometry: the vertical axis and the origin.
        {
          id: A.fromAxis,
          kind: 'linear',
          origin: model,
          refs: [ax(holes, '@y'), pt(holes, 'H2c')],
          direction: [1, 0, 0],
        },
        {
          id: A.fromXAxis,
          kind: 'linear',
          origin: model,
          refs: [ax(holes, '@x'), pt(holes, '@origin')],
        },
        // `-length/2`: the corner from the origin (a signed hDistance shown as a distance).
        {
          id: A.half,
          kind: 'linear',
          origin: model,
          refs: [pt(base, 'o'), pt(base, 'La')],
          direction: [1, 0, 0],
          source: src(base, 'hDistance', 'o', 'La'),
        },
        {
          id: A.pocketY,
          kind: 'linear',
          origin: model,
          refs: [pt(pocket, '@origin'), pt(pocket, 'Pa')],
          direction: [0, 1, 0],
          source: src(pocket, 'vDistance', 'o', 'Pa'),
        },
      ];
      part(doc).annotations = anns;
      return { doc, holes, base, pocket };
    }

    it('resolve against the final sketch frame, with point and line anchors', async () => {
      const { doc } = annotated();
      const r = await regen(doc);
      allOk(r);
      for (const a of r.annotations ?? []) expect(a.state, JSON.stringify(a)).toBe('ok');

      const hx = get(r, A.holeX);
      expect(hx.value).toBeCloseTo(45, 12);
      expect(hx.measured).toBeCloseTo(45, 9);
      close(point(hx.anchors?.[0]), [0, 0, 12]);
      close(point(hx.anchors?.[1]), [45, 25, 12]);
      expect(get(r, A.holeY).value).toBeCloseTo(25, 12);
      expect(get(r, A.holeY).measured).toBeCloseTo(25, 9);

      // The vertical axis of the hole sketch: a line through its origin along y, across the part.
      const axis = get(r, A.fromAxis);
      expect(axis.measured).toBeCloseTo(45, 9);
      const l = line(axis.anchors?.[0]);
      close(l.a, [0, -40, 12], 6);
      close(l.b, [0, 40, 12], 6);
      // Origin to its own x axis: zero.
      expect(get(r, A.fromXAxis).measured).toBeCloseTo(0, 12);

      // Signed sketch distances are shown as distances.
      expect(get(r, A.half).value).toBeCloseTo(60, 12);
      expect(get(r, A.half).measured).toBeCloseTo(60, 9);
      const py = get(r, A.pocketY);
      expect(py.value).toBeCloseTo(20, 12);
      expect(py.measured).toBeCloseTo(20, 9);
      close(point(py.anchors?.[0]), [0, 0, 12]);
    }, 120_000);

    it('edit upstream: thickness 16 and length 140 move the anchors, values follow', async () => {
      const { doc } = annotated();
      await regen(doc);
      const r = await regen(toStage(P, doc, { thickness: 16, length: 140 }));
      allOk(r);
      const hx = get(r, A.holeX);
      expect(hx.state).toBe('ok');
      close(point(hx.anchors?.[0]), [0, 0, 16]);
      close(point(hx.anchors?.[1]), [45, 25, 16]);
      expect(get(r, A.half).value).toBeCloseTo(70, 12);
      expect(get(r, A.half).measured).toBeCloseTo(70, 9);
      const l = line(get(r, A.fromAxis).anchors?.[0]);
      close(l.a, [0, -40, 16], 6);
      close(l.b, [0, 40, 16], 6);
    }, 120_000);

    it('a suppressed sketch is "not in this configuration"; a failed one needs attention with its cause', async () => {
      const { doc, holes, pocket } = annotated();
      await regen(doc);
      const sup = structuredClone(doc);
      const hs = part(sup).features.find((f) => f.id === holes);
      if (hs) hs.suppressed = true;
      const r1 = await regen(sup);
      const hx = get(r1, A.holeX);
      expect(hx.state).toBe('suppressed');
      expect(hx.cause).toEqual({ featureId: holes, kind: 'suppressed' });
      expect(hx.value).toBeUndefined();

      // The pocket sketch's face no longer exists: the sketch fails, the dimension says so.
      const bad = structuredClone(doc);
      const ps = part(bad).features.find((f) => f.id === pocket) as SketchFeature;
      ps.on = { name: `F${fid('GONE')}:end`, kind: 'face' };
      const r2 = await regen(bad);
      const py = get(r2, A.pocketY);
      expect(py.state).toBe('needsAttention');
      expect(py.value).toBeUndefined();
      expect(py.cause?.featureId).toBe(pocket);
      expect(py.cause?.kind).toBe('failed');
      expect(py.unresolved?.map((u) => u.path).sort()).toEqual(['/refs/0', '/refs/1']);
      expect(py.error?.message).toMatch(/failed/);
      // The holes are untouched.
      expect(get(r2, A.holeX).state).toBe('ok');
    }, 120_000);

    it('annotationAnchors lists a sketch origin and its axes on the sketch frame', async () => {
      const { doc, holes, base } = annotated();
      const r = await regen(doc);
      for (const sk of [holes, base]) {
        const frame = r.sketches.find((s) => s.featureId === sk)?.frame;
        if (!frame) throw new Error('no sketch frame');
        const q = await api.annotationAnchors(part(doc).id, [
          { ref: { name: `S${sk}:p(@origin)`, kind: 'vertex' } },
          { ref: { name: `S${sk}:e(@x)`, kind: 'edge' } },
          { ref: { name: `S${sk}:e(@y)`, kind: 'edge' } },
        ]);
        if (!q.ok) throw new Error(JSON.stringify(q.error));
        for (const a of q.value) expect(a.unresolved).toBeUndefined();
        const [o, x, y] = q.value.map((a) => a.anchor);
        close(point(o), frame.origin);
        for (const [l, dir] of [
          [line(x), frame.x],
          [line(y), frame.y],
        ] as const) {
          const d: Vec3 = [l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]];
          const n = Math.hypot(...d);
          close(d.map((v) => v / n) as Vec3, dir.map((v) => v / Math.hypot(...dir)) as Vec3);
          // Through the origin, across the part (120 × 80).
          const t = (p: Vec3) =>
            (p[0] - frame.origin[0]) * dir[0] + (p[1] - frame.origin[1]) * dir[1];
          expect(Math.abs(t(l.a)) + Math.abs(t(l.b))).toBeGreaterThan(79);
          const off: Vec3 = [
            l.a[0] - frame.origin[0] - t(l.a) * dir[0],
            l.a[1] - frame.origin[1] - t(l.a) * dir[1],
            l.a[2] - frame.origin[2] - t(l.a) * dir[2],
          ];
          close(off, [0, 0, 0], 6);
        }
      }
      // A sketch that is not in the model: unresolved with the reason, never an anchor.
      const q = await api.annotationAnchors(part(doc).id, [
        { ref: { name: `S${fid('NOSK')}:p(@origin)`, kind: 'vertex' } },
      ]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      expect(q.value[0]?.anchor).toBeNull();
      expect(q.value[0]?.unresolved?.cause).toEqual({ featureId: fid('NOSK'), kind: 'deleted' });
    }, 120_000);

    it('every promoted origin dimension of rp03, rp04, rp05, rp06 and rp07 resolves', async () => {
      for (const id of ['rp03', 'rp04', 'rp05', 'rp06', 'rp07']) {
        const p = partDef(id);
        const doc = buildDoc(p);
        const frames = new Map((await regen(doc)).sketches.map((s) => [s.featureId, s.frame]));
        const anns: Annotation[] = [];
        for (const f of part(doc).features) {
          if (f.type !== 'sketch') continue;
          const frame = frames.get(f.id);
          if (!frame) throw new Error(`${id}: no frame for ${f.id}`);
          for (const c of f.constraints) {
            if (c.kind !== 'hDistance' && c.kind !== 'vDistance') continue;
            if (c.a !== 'o' && c.a !== '@origin') continue;
            // As Import promotes them: along the sketch's x or y.
            anns.push({
              id: fid(`RO${anns.length}`),
              kind: 'linear',
              origin: model,
              refs: [
                { name: `S${f.id}:p(${c.a})`, kind: 'vertex' },
                { name: `S${f.id}:p(${c.b})`, kind: 'vertex' },
              ],
              direction: c.kind === 'hDistance' ? frame.x : frame.y,
              source: { kind: 'sketchDimension', featureId: f.id, constraintId: c.id },
            });
          }
        }
        expect(anns.length, id).toBeGreaterThan(0);
        part(doc).annotations = anns;
        const r = await regen(doc);
        for (const a of r.annotations ?? []) {
          expect(a.state, `${id} ${JSON.stringify(a)}`).toBe('ok');
          // The sketch's value, and the geometry agrees.
          expect(a.value, id).toBeGreaterThanOrEqual(0);
          expect(a.measured, id).toBeCloseTo(a.value as number, 9);
        }
        await api.closePart(part(doc).id);
      }
    }, 300_000);
  });

  // -------------------------------------------------------------------------------------------
  // GAP-EXTRUDE-DEPTH
  // -------------------------------------------------------------------------------------------

  describe('GAP-EXTRUDE-DEPTH: depths of cuts and of adds whose faces changed', () => {
    const DEPTH = fid('RADP');
    const OWN = fid('RADO');
    const depth = (featureId: Id, refs: EntityRef[], id = DEPTH): Annotation => ({
      id,
      kind: 'linear',
      origin: model,
      refs,
      direction: [0, 0, 1],
      source: { kind: 'featureField', featureId, path: '/end/depth' },
    });

    it('rp01 pocket (a cut): from the placement face to the floor; the cut has no start face', async () => {
      const P = partDef('rp01');
      const doc = buildDoc(P);
      const base = stepId(P, doc, 'base');
      const pocket = stepId(P, doc, 'pocket');
      part(doc).annotations = [
        depth(pocket, [face(`F${base}:end`), face(`F${pocket}:end`)]),
        depth(pocket, [face(`F${pocket}:start`), face(`F${pocket}:end`)], OWN),
      ];
      const r = await regen(doc);
      allOk(r);
      const d = get(r, DEPTH);
      expect(d.state, JSON.stringify(d)).toBe('ok');
      expect(d.value).toBeCloseTo(5, 12);
      expect(d.measured).toBeCloseTo(5, 9);
      expect(d.merged).toBeUndefined();
      expect(planeZ(d.anchors?.[0])).toBeCloseTo(12, 9);
      expect(planeZ(d.anchors?.[1])).toBeCloseTo(7, 9);
      // The floor's outline is the pocket (40 × 14 at y 20..34).
      const floor = d.anchors?.[1];
      if (floor?.kind !== 'plane') throw new Error('plane');
      expect(Math.min(...floor.outline.map((p) => p[1]))).toBeCloseTo(20, 9);
      expect(Math.max(...floor.outline.map((p) => p[1]))).toBeCloseTo(34, 9);
      // A cut's start face is the opening it made: nothing to resolve, and nothing guessed.
      const own = get(r, OWN);
      expect(own.state).toBe('needsAttention');
      expect(own.unresolved?.map((u) => [u.path, u.reason])).toEqual([['/refs/0', 'missing']]);
      expect(own.value).toBeUndefined();

      // Edit upstream: pocket_d 8 and thickness 16.
      const r2 = await regen(toStage(P, doc, { pocket_d: 8, thickness: 16 }));
      allOk(r2);
      const d2 = get(r2, DEPTH);
      expect(d2.state).toBe('ok');
      expect(d2.value).toBeCloseTo(8, 12);
      expect(d2.measured).toBeCloseTo(8, 9);
      expect(planeZ(d2.anchors?.[0])).toBeCloseTo(16, 9);
      expect(planeZ(d2.anchors?.[1])).toBeCloseTo(8, 9);
    }, 120_000);

    it('rp05 housing: the shell opened the end face; its rim is in that plane (reported as merged)', async () => {
      const P = partDef('rp05');
      const doc = buildDoc(P);
      const base = stepId(P, doc, 'base');
      const shell = stepId(P, doc, 'sh');
      const FINISH = fid('RADF');
      part(doc).annotations = [
        depth(base, [face(`F${base}:start`), face(`F${base}:end`)]),
        depth(base, [face('origin:XY'), face(`F${base}:end`)], OWN),
        // Not a plane measurement: the rim is not the face that was opened.
        {
          id: FINISH,
          kind: 'surfaceFinish',
          origin: model,
          refs: [face(`F${base}:end`)],
          process: 'removalRequired',
          requirements: [{ parameter: 'Ra', value: '1.6 µm' }],
        },
      ];
      const r = await regen(doc);
      allOk(r);
      const rim = `F${shell}:rim(F${base}:end)`;
      for (const id of [DEPTH, OWN]) {
        const d = get(r, id);
        expect(d.state, JSON.stringify(d)).toBe('ok');
        expect(d.value).toBeCloseTo(40, 12);
        expect(d.measured).toBeCloseTo(40, 9);
        expect(d.merged).toEqual([{ path: '/refs/1', name: `F${base}:end`, into: rim }]);
        expect(planeZ(d.anchors?.[1])).toBeCloseTo(40, 9);
      }
      const fin = get(r, FINISH);
      expect(fin.state).toBe('needsAttention');
      expect(fin.unresolved?.map((u) => [u.path, u.reason])).toEqual([['/refs/0', 'missing']]);

      // The query the import planner makes gives the same answer.
      const q = await api.annotationAnchors(part(doc).id, [
        { ref: face(`F${base}:end`), annotationKind: 'linear' },
        { ref: face(`F${base}:end`) },
      ]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      expect(q.value[0]?.merged).toEqual({ path: '/0', name: `F${base}:end`, into: rim });
      expect(planeZ(q.value[0]?.anchor)).toBeCloseTo(40, 9);
      expect(q.value[1]?.anchor).toBeNull();

      // Edit upstream: height 50, base_l 100.
      const r2 = await regen(toStage(P, doc, { height: 50, base_l: 100 }));
      allOk(r2);
      const d2 = get(r2, DEPTH);
      expect(d2.state).toBe('ok');
      expect(d2.value).toBeCloseTo(50, 12);
      expect(d2.measured).toBeCloseTo(50, 9);
      expect(planeZ(d2.anchors?.[1])).toBeCloseTo(50, 9);

      // Without the shell the end face is itself again: no merge reported.
      const plain = structuredClone(doc);
      const sh = part(plain).features.find((f) => f.id === shell);
      if (sh) sh.suppressed = true;
      const r3 = await regen(plain);
      const d3 = get(r3, DEPTH);
      expect(d3.state).toBe('ok');
      expect(d3.merged).toBeUndefined();
      expect(d3.measured).toBeCloseTo(40, 9);
    }, 120_000);

    it('rp06 block: the groove splits the end face into coplanar pieces, one plane', async () => {
      const P = partDef('rp06');
      const doc = buildDoc(P);
      const base = stepId(P, doc, 'base');
      part(doc).annotations = [depth(base, [face(`F${base}:start`), face(`F${base}:end`)])];
      const r = await regen(doc);
      allOk(r);
      const d = get(r, DEPTH);
      expect(d.state, JSON.stringify(d)).toBe('ok');
      expect(d.value).toBeCloseTo(20, 12);
      expect(d.measured).toBeCloseTo(20, 9);
      expect(planeZ(d.anchors?.[1])).toBeCloseTo(20, 9);
      // Reported: the stored name now has pieces.
      expect(d.rebound?.[0]?.path).toBe('/refs/1');
      expect(d.rebound?.[0]?.name).toMatch(new RegExp(`^F${base}:end#\\d$`));

      // An aligned dimension (not a plane measurement) stays ambiguous: never a pick.
      const ALIGNED = fid('RADA');
      part(doc).annotations?.push({
        id: ALIGNED,
        kind: 'aligned',
        origin: model,
        refs: [face(`F${base}:start`), face(`F${base}:end`)],
      });
      const ra = await regen(doc);
      const a = get(ra, ALIGNED);
      expect(a.state).toBe('needsAttention');
      expect(a.unresolved?.[0]?.reason).toBe('ambiguous');

      // Edit upstream: blk_t 25.
      const r2 = await regen(toStage(P, doc, { blk_t: 25, ch_bend: 12 }));
      const d2 = get(r2, DEPTH);
      expect(d2.state).toBe('ok');
      expect(d2.value).toBeCloseTo(25, 12);
      expect(d2.measured).toBeCloseTo(25, 9);
    }, 120_000);

    it('rp04 boss: the Boolean carries the end face on; the push/pull moved it, so the measurement disagrees', async () => {
      const P = partDef('rp04');
      const doc = buildDoc(P);
      const base = stepId(P, doc, 'base');
      const boss = stepId(P, doc, 'boss');
      const join = stepId(P, doc, 'join');
      part(doc).annotations = [depth(boss, [face(`F${base}:end`), face(`F${boss}:end`)])];
      const r = await regen(doc);
      allOk(r);
      const d = get(r, DEPTH);
      expect(d.state, JSON.stringify(d)).toBe('ok');
      expect(d.merged).toEqual([
        { path: '/refs/1', name: `F${boss}:end`, into: `F${join}:face(F${boss}:end)` },
      ]);
      // The depth as first extruded (boss_h - boss_up = 20) against the boss as built (boss_h 26):
      // the drawing flags "differs from the model"; the kernel never moves the anchor to agree.
      expect(d.value).toBeCloseTo(20, 12);
      expect(d.measured).toBeCloseTo(26, 9);
      expect(planeZ(d.anchors?.[1])).toBeCloseTo(42, 9);

      // Without the push/pull they agree.
      const noPull = structuredClone(doc);
      const pull = stepId(P, doc, 'pull');
      const cboss = stepId(P, doc, 'cboss');
      for (const f of part(noPull).features)
        if (f.id === pull || f.id === cboss) f.suppressed = true;
      const r2 = await regen(noPull);
      const d2 = get(r2, DEPTH);
      expect(d2.state).toBe('ok');
      expect(d2.measured).toBeCloseTo(20, 9);
    }, 120_000);
  });

  // -------------------------------------------------------------------------------------------
  // Counts
  // -------------------------------------------------------------------------------------------

  describe('count: instances of the feature behind refs[0], copies included', () => {
    const DIA = fid('RACD');
    const CALL = fid('RACC');
    const EDGE = fid('RACE');
    const ONE = fid('RAC1');

    async function edgeNames(doc: WrenDoc): Promise<string[]> {
      const s = await api.shapeForDrawing(part(doc).id, 'main');
      if (!s.ok) throw new Error(JSON.stringify(s.error));
      return s.value.edgeNames;
    }

    it('rp08: three tapped holes (a pattern of 4 with one skipped), one counterbore', async () => {
      const P = partDef('rp08');
      const doc = buildDoc(P);
      const pts = stepId(P, doc, 'pts_sk');
      const tap = stepId(P, doc, 'h_tap');
      const cb = stepId(P, doc, 'h_cb');
      const wall = `F${tap}:hole(S${pts}:p(TP)):wall`;
      part(doc).annotations = [
        {
          id: DIA,
          kind: 'diameter',
          origin: model,
          refs: [face(wall)],
          text: { count: true },
        },
        {
          id: CALL,
          kind: 'holeCallout',
          origin: model,
          refs: [],
          source: { kind: 'feature', featureId: tap },
          text: { count: true },
        },
        {
          id: ONE,
          kind: 'holeCallout',
          origin: model,
          refs: [],
          source: { kind: 'feature', featureId: cb },
          text: { count: true },
        },
      ];
      const r0 = await regen(doc);
      allOk(r0);
      // A rim edge of the original tapped hole (edges count too).
      const rim = (await edgeNames(doc)).find(
        (n) => n.startsWith('edge(') && n.includes(wall) && !n.includes(':inst'),
      );
      if (!rim) throw new Error('no rim edge');
      part(doc).annotations?.push({
        id: EDGE,
        kind: 'diameter',
        origin: model,
        refs: [{ name: rim, kind: 'edge' }],
        text: { count: true },
      });
      const r = await regen(doc);
      for (const id of [DIA, CALL, EDGE]) {
        const a = get(r, id);
        expect(a.state, JSON.stringify(a)).toBe('ok');
        expect(a.count, id).toBe(3);
      }
      expect(get(r, CALL).instances).toHaveLength(3);
      expect(get(r, ONE).count).toBe(1);

      // Edit upstream: tap_n 4 → four holes (five positions, one skipped).
      const r2 = await regen(toStage(P, doc, { tap_n: 4, tap_dx: 16, tap_x0: -32 }));
      allOk(r2);
      for (const id of [DIA, CALL, EDGE]) expect(get(r2, id).count, id).toBe(4);

      // Without `text.count`, no count.
      const plain = structuredClone(doc);
      for (const a of part(plain).annotations ?? []) if ('text' in a) delete a.text;
      const r3 = await regen(plain);
      expect(get(r3, DIA).count).toBeUndefined();
    }, 120_000);

    it('rp09: six bolt holes (a circular pattern of 8 with two skipped)', async () => {
      const P = partDef('rp09');
      const doc = buildDoc(P);
      const sk = stepId(P, doc, 'bolt_sk');
      const bolt = stepId(P, doc, 'bolt');
      part(doc).annotations = [
        {
          id: DIA,
          kind: 'diameter',
          origin: model,
          refs: [face(`F${bolt}:hole(S${sk}:p(P)):wall`)],
          text: { count: true },
        },
        {
          id: CALL,
          kind: 'holeCallout',
          origin: model,
          refs: [],
          source: { kind: 'feature', featureId: bolt },
          text: { count: true },
        },
      ];
      const r = await regen(doc);
      allOk(r);
      expect(get(r, DIA).count).toBe(6);
      expect(get(r, DIA).value).toBeCloseTo(9, 9);
      expect(get(r, CALL).count).toBe(6);
      // Edit upstream: bolt_n 8 (ten positions, 2 and 5 still skipped).
      const r2 = await regen(toStage(P, doc, { bolt_n: 8 }));
      allOk(r2);
      expect(get(r2, DIA).count).toBe(8);
      expect(get(r2, CALL).count).toBe(8);
    }, 120_000);

    it('rp10: five slots (a pattern of 6 with one skipped); the ear hole and its mirror copy', async () => {
      const P = partDef('rp10');
      const doc = buildDoc(P);
      const slotSk = stepId(P, doc, 'slot_sk');
      const slot = stepId(P, doc, 'slot');
      const ehSk = stepId(P, doc, 'eh_sk');
      const eh = stepId(P, doc, 'eh');
      const base = stepId(P, doc, 'base');
      const side = (f: Id, sk: Id, e: string) => face(`F${f}:side(S${sk}:e(${e}))`);
      const EAR = fid('RACR');
      const PLATE = fid('RACP');
      part(doc).annotations = [
        {
          id: DIA,
          kind: 'linear',
          origin: model,
          refs: [side(slot, slotSk, 'S1'), side(slot, slotSk, 'S3')],
          text: { count: true },
        },
        {
          id: EAR,
          kind: 'diameter',
          origin: model,
          refs: [side(eh, ehSk, 'C')],
          text: { count: true },
        },
        {
          id: PLATE,
          kind: 'linear',
          origin: model,
          refs: [face(`F${base}:start`), face(`F${base}:end`)],
          text: { count: true },
        },
      ];
      const r = await regen(doc);
      allOk(r);
      const s = get(r, DIA);
      expect(s.state, JSON.stringify(s)).toBe('ok');
      expect(s.count).toBe(5);
      expect(get(r, EAR).count).toBe(2);
      expect(get(r, PLATE).count).toBe(1);
      // Edit upstream: slot_n 6 → six slots (seven positions, one skipped).
      const r2 = await regen(toStage(P, doc, { slot_n: 6, slot_pitch: 15 }));
      allOk(r2);
      expect(get(r2, DIA).count).toBe(6);
      expect(get(r2, EAR).count).toBe(2);
    }, 120_000);
  });

  // -------------------------------------------------------------------------------------------
  // M4.1 (ADR-095): construction refs, pitch circles, extremes, draft angles, torus radii
  // -------------------------------------------------------------------------------------------

  describe('M4.1 CONSTRUCTION: pitch circles of circular patterns (rp09 pcd)', () => {
    const P = partDef('rp09');
    const DIA = fid('M1PD');
    const RAD = fid('M1PR');
    const ACROSS = fid('M1PA');

    function annotated(): { doc: WrenDoc; ring: Id; pitch: EntityRef } {
      const doc = buildDoc(P);
      const ring = stepId(P, doc, 'ring');
      const pitch: EntityRef = { name: `F${ring}:pitch`, kind: 'edge' };
      part(doc).annotations = [
        { id: DIA, kind: 'diameter', origin: model, refs: [pitch] },
        { id: RAD, kind: 'radius', origin: model, refs: [pitch] },
        {
          id: ACROSS,
          kind: 'linear',
          origin: model,
          refs: [pitch, pitch],
          at: ['min', 'max'],
          direction: [0, 1, 0],
        },
      ];
      return { doc, ring, pitch };
    }

    function circle(a: AnnotationAnchor | null | undefined) {
      if (a?.kind !== 'circle') throw new Error(`circle anchor: ${JSON.stringify(a)}`);
      return a;
    }

    it('F<ring>:pitch is the Ø90 circle about the pattern axis at the flange top; it follows pcd', async () => {
      const { doc, pitch } = annotated();
      const r = await regen(doc);
      allOk(r);
      const d = get(r, DIA);
      expect(d.state, JSON.stringify(d)).toBe('ok');
      expect(d.value).toBeCloseTo(90, 9);
      expect(d.measured).toBeCloseTo(90, 9);
      const c = circle(d.anchors?.[0]);
      close(c.center, [0, 0, 12]);
      close(c.normal, [0, 0, 1]);
      expect(c.radius).toBeCloseTo(45, 9);
      expect(c.start).toBeUndefined();
      expect(get(r, RAD).value).toBeCloseTo(45, 9);
      // Linear across the circle: 90, its feet at the extremes along y.
      const a = get(r, ACROSS);
      expect(a.state).toBe('ok');
      expect(a.value).toBeCloseTo(90, 9);
      close(point(a.anchors?.[0]), [0, -45, 12]);
      close(point(a.anchors?.[1]), [0, 45, 12]);

      // The anchor query a drawing makes for construction candidates gives the same circle.
      const q = await api.annotationAnchors(part(doc).id, [{ ref: pitch }]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      expect(q.value[0]?.unresolved).toBeUndefined();
      const qc = circle(q.value[0]?.anchor);
      close(qc.center, [0, 0, 12]);
      expect(qc.radius).toBeCloseTo(45, 9);

      // Edit upstream: bolt_n 8 (more instances, same circle), then pcd 100.
      const r2 = await regen(toStage(P, doc, { bolt_n: 8 }));
      allOk(r2);
      expect(get(r2, DIA).value).toBeCloseTo(90, 9);
      const r3 = await regen(toStage(P, doc, { pcd: 100 }));
      allOk(r3);
      expect(get(r3, DIA).state).toBe('ok');
      expect(get(r3, DIA).value).toBeCloseTo(100, 9);
      expect(get(r3, RAD).value).toBeCloseTo(50, 9);
      expect(get(r3, ACROSS).value).toBeCloseTo(100, 9);
      close(circle(get(r3, DIA).anchors?.[0]).center, [0, 0, 12]);
    }, 120_000);

    it('a deleted pattern: needs attention, cause deleted; a suppressed one: suppressed', async () => {
      const { doc, ring } = annotated();
      await regen(doc);
      const gone = structuredClone(doc);
      part(gone).features = part(gone).features.filter((f) => f.id !== ring);
      part(gone).rollbackIndex = part(gone).features.length;
      const r1 = await regen(gone);
      const d1 = get(r1, DIA);
      expect(d1.state).toBe('needsAttention');
      expect(d1.cause).toEqual({ featureId: ring, kind: 'deleted' });
      expect(d1.unresolved?.map((u) => [u.path, u.reason])).toEqual([['/refs/0', 'missing']]);
      expect(d1.value).toBeUndefined();
      expect(d1.anchors).toEqual([null]);

      const sup = structuredClone(doc);
      const f = part(sup).features.find((x) => x.id === ring);
      if (f) f.suppressed = true;
      const r2 = await regen(sup);
      const d2 = get(r2, DIA);
      expect(d2.state).toBe('suppressed');
      expect(d2.cause).toEqual({ featureId: ring, kind: 'suppressed' });
      expect(d2.value).toBeUndefined();
      // The query says why too.
      const q = await api.annotationAnchors(part(sup).id, [
        { ref: { name: `F${ring}:pitch`, kind: 'edge' } },
      ]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      expect(q.value[0]?.anchor).toBeNull();
      expect(q.value[0]?.unresolved?.cause).toEqual({ featureId: ring, kind: 'suppressed' });
    }, 120_000);

    it('a feature that is not a circular pattern of holes has no pitch circle: an error, never a guess', async () => {
      const doc = buildDoc(P);
      const hub = stepId(P, doc, 'hub');
      const bolt = stepId(P, doc, 'bolt');
      const NOT = fid('M1PN');
      const HOLE = fid('M1PH');
      part(doc).annotations = [
        {
          id: NOT,
          kind: 'diameter',
          origin: model,
          refs: [{ name: `F${hub}:pitch`, kind: 'edge' }],
        },
        {
          id: HOLE,
          kind: 'diameter',
          origin: model,
          refs: [{ name: `F${bolt}:pitch`, kind: 'edge' }],
        },
      ];
      const r = await regen(doc);
      allOk(r);
      for (const id of [NOT, HOLE]) {
        const a = get(r, id);
        expect(a.state).toBe('needsAttention');
        expect(a.value).toBeUndefined();
        expect(a.cause).toBeUndefined();
        expect(a.unresolved?.map((u) => u.path)).toEqual(['/refs/0']);
        expect(a.error?.message).toMatch(/not a circular pattern/);
      }
    }, 120_000);
  });

  describe('M4.1 CONSTRUCTION: origin and construction axes, planes and points', () => {
    function axis(a: AnnotationAnchor | null | undefined) {
      if (a?.kind !== 'axis') throw new Error(`axis anchor: ${JSON.stringify(a)}`);
      return a;
    }

    it('origin axes and axis features span the part (rp09: Ø120 × 42), and follow it', async () => {
      const P = partDef('rp09');
      const doc = buildDoc(P);
      const ax = stepId(P, doc, 'ax');
      const queries = [
        { ref: { name: 'origin:X', kind: 'edge' as const } },
        { ref: { name: 'origin:Y', kind: 'edge' as const } },
        { ref: { name: 'origin:Z', kind: 'edge' as const } },
        { ref: { name: `F${ax}:axis`, kind: 'edge' as const } },
      ];
      await regen(doc);
      const q = await api.annotationAnchors(part(doc).id, queries);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      const [x, y, z, f] = [0, 1, 2, 3].map((i) => axis(q.value[i]?.anchor)) as [
        ReturnType<typeof axis>,
        ReturnType<typeof axis>,
        ReturnType<typeof axis>,
        ReturnType<typeof axis>,
      ];
      for (const [a, dir] of [
        [x, [1, 0, 0]],
        [y, [0, 1, 0]],
        [z, [0, 0, 1]],
      ] as const) {
        close(a.origin, [0, 0, 0]);
        close(a.direction, [...dir]);
      }
      // Across the bodies' bounds, and at least ±1 mm about the origin.
      expect(x.extent[0]).toBeCloseTo(-60, 9);
      expect(x.extent[1]).toBeCloseTo(60, 9);
      expect(y.extent[0]).toBeCloseTo(-60, 9);
      expect(y.extent[1]).toBeCloseTo(60, 9);
      expect(z.extent[0]).toBeCloseTo(-1, 9);
      expect(z.extent[1]).toBeCloseTo(42, 9);
      // The reference axis from the bore: on Z, spanning the hub's height.
      expect(Math.abs(f.direction[2])).toBeCloseTo(1, 12);
      const ends = f.extent.map((t) => f.origin[2] + t * f.direction[2]).sort((a, b) => a - b);
      expect(ends[0]).toBeLessThanOrEqual(1e-9);
      expect(ends[1]).toBeGreaterThanOrEqual(42 - 1e-9);

      // Measured by position and direction only: the reference axis to the bolt hole's axis is
      // the pitch radius, the Z axis to it too, the X axis to the hole's centre line 0.
      const sk = stepId(P, doc, 'bolt_sk');
      const bolt = stepId(P, doc, 'bolt');
      const wall = face(`F${bolt}:hole(S${sk}:p(P)):wall`);
      const ids = { ax: fid('M1AA'), z: fid('M1AZ'), x: fid('M1AX') };
      const measured = structuredClone(doc);
      part(measured).annotations = [
        {
          id: ids.ax,
          kind: 'linear',
          origin: model,
          refs: [queries[3]?.ref as EntityRef, wall],
          at: ['self', 'axis'],
        },
        {
          id: ids.z,
          kind: 'linear',
          origin: model,
          refs: [queries[2]?.ref as EntityRef, wall],
          at: ['self', 'axis'],
          direction: [1, 0, 0],
        },
        {
          id: ids.x,
          kind: 'linear',
          origin: model,
          refs: [queries[0]?.ref as EntityRef, wall],
          at: ['self', 'axis'],
          direction: [0, 1, 0],
        },
      ];
      const rm = await regen(measured);
      allOk(rm);
      expect(get(rm, ids.ax).value).toBeCloseTo(45, 9);
      expect(get(rm, ids.z).value).toBeCloseTo(45, 9);
      expect(get(rm, ids.x).value).toBeCloseTo(0, 9);
      const rp = await regen(toStage(P, measured, { pcd: 100 }));
      expect(get(rp, ids.ax).value).toBeCloseTo(50, 9);

      // Edit upstream: hub_h 45 makes the part 57 tall.
      await regen(toStage(P, doc, { hub_h: 45, bore_d: 36 }));
      const q2 = await api.annotationAnchors(part(doc).id, queries.slice(2, 3));
      if (!q2.ok) throw new Error(JSON.stringify(q2.error));
      expect(axis(q2.value[0]?.anchor).extent[1]).toBeCloseTo(57, 9);
    }, 120_000);

    it('rp03: origin:X to the flat (its rim seen edge-on, its face, its plane) = 18; flat_h 10 → 10', async () => {
      const P = partDef('rp03');
      const doc = buildDoc(P);
      const ball = stepId(P, doc, 'ball');
      const ballSk = stepId(P, doc, 'ball_sk');
      const flat = stepId(P, doc, 'flat');
      const plane = stepId(P, doc, 'flat_pl');
      const sphere = `F${ball}:side(S${ballSk}:e(A1))`;
      const rim: EntityRef = {
        name: `edge(${[sphere, `F${flat}:start`].sort().join('|')})`,
        kind: 'edge',
      };
      const X: EntityRef = { name: 'origin:X', kind: 'edge' };
      const ids = {
        rimZ: fid('M1FZ'),
        rim: fid('M1FR'),
        face: fid('M1FF'),
        plane: fid('M1FP'),
        point: fid('M1FO'),
        ball: fid('M1FB'),
      };
      part(doc).annotations = [
        // As the Dimension tool makes it in the front view: vertical, between two horizontal lines.
        { id: ids.rimZ, kind: 'linear', origin: model, refs: [X, rim], direction: [0, 0, 1] },
        { id: ids.rim, kind: 'linear', origin: model, refs: [X, rim] },
        { id: ids.face, kind: 'linear', origin: model, refs: [X, face(`F${flat}:start`)] },
        {
          id: ids.plane,
          kind: 'linear',
          origin: model,
          refs: [face('origin:XY'), face(`F${plane}:plane`)],
        },
        {
          id: ids.point,
          kind: 'linear',
          origin: model,
          refs: [{ name: 'origin:O', kind: 'vertex' }, face(`F${plane}:plane`)],
        },
        // The ball across, at its extremes (a sphere's tangent points).
        {
          id: ids.ball,
          kind: 'linear',
          origin: model,
          refs: [face(sphere), face(sphere)],
          at: ['min', 'max'],
          direction: [1, 0, 0],
        },
      ];
      const r = await regen(doc);
      allOk(r);
      for (const id of [ids.rimZ, ids.rim, ids.face, ids.plane, ids.point]) {
        const a = get(r, id);
        expect(a.state, JSON.stringify(a)).toBe('ok');
        expect(a.value, id).toBeCloseTo(18, 9);
      }
      // The X axis anchor spans the part (the ball's Ø50 and the stem), so it can be drawn.
      const xa = get(r, ids.rim).anchors?.[0];
      if (xa?.kind !== 'axis') throw new Error('axis');
      expect(xa.extent[0]).toBeCloseTo(-25, 6);
      expect(xa.extent[1]).toBeCloseTo(25, 6);
      const b = get(r, ids.ball);
      expect(b.value).toBeCloseTo(50, 9);
      close(point(b.anchors?.[0]), [-25, 0, 0]);
      close(point(b.anchors?.[1]), [25, 0, 0]);

      // Edit upstream: flat_h 10, then ball_d 60.
      const r2 = await regen(toStage(P, doc, { flat_h: 10 }));
      allOk(r2);
      for (const id of [ids.rimZ, ids.rim, ids.face, ids.plane, ids.point]) {
        expect(get(r2, id).value, id).toBeCloseTo(10, 9);
      }
      const r3 = await regen(toStage(P, doc, { ball_d: 60 }));
      allOk(r3);
      expect(get(r3, ids.ball).value).toBeCloseTo(60, 9);
      expect(get(r3, ids.rimZ).value).toBeCloseTo(18, 9);
    }, 120_000);

    it('rp08: origin:Y / origin:X to the countersink rim centre = 30 / 18; sketch and point refs', async () => {
      const P = partDef('rp08');
      const doc = buildDoc(P);
      const base = stepId(P, doc, 'base');
      const pt = stepId(P, doc, 'cs_pt');
      const pts = stepId(P, doc, 'pts_sk');
      const cs = stepId(P, doc, 'h_cs');
      const csink = `F${cs}:hole(F${pt}:point):csink`;
      const rim: EntityRef = {
        name: `edge(${[`F${base}:end`, csink].sort().join('|')})`,
        kind: 'edge',
      };
      const ids = {
        csX: fid('M1CX'),
        csY: fid('M1CY'),
        ptX: fid('M1PX'),
        cbX: fid('M1BX'),
        tapX: fid('M1TX'),
        tapY: fid('M1TY'),
      };
      const Y: EntityRef = { name: 'origin:Y', kind: 'edge' };
      const X: EntityRef = { name: 'origin:X', kind: 'edge' };
      const sp = (id: string): EntityRef => ({ name: `S${pts}:p(${id})`, kind: 'vertex' });
      part(doc).annotations = [
        {
          id: ids.csX,
          kind: 'linear',
          origin: model,
          refs: [Y, rim],
          at: ['self', 'center'],
          direction: [1, 0, 0],
        },
        {
          id: ids.csY,
          kind: 'linear',
          origin: model,
          refs: [X, rim],
          at: ['self', 'center'],
          direction: [0, 1, 0],
        },
        {
          id: ids.ptX,
          kind: 'linear',
          origin: model,
          refs: [Y, { name: `F${pt}:point`, kind: 'vertex' }],
          direction: [1, 0, 0],
        },
        { id: ids.cbX, kind: 'linear', origin: model, refs: [Y, sp('CB')], direction: [1, 0, 0] },
        {
          id: ids.tapX,
          kind: 'linear',
          origin: model,
          refs: [sp('@origin'), sp('TP')],
          direction: [1, 0, 0],
        },
        {
          id: ids.tapY,
          kind: 'linear',
          origin: model,
          refs: [{ name: `S${pts}:e(@x)`, kind: 'edge' }, sp('TP')],
        },
      ];
      const r = await regen(doc);
      allOk(r);
      const want: [string, number][] = [
        [ids.csX, 30],
        [ids.csY, 18],
        [ids.ptX, 30],
        [ids.cbX, 30],
        [ids.tapX, 36],
        [ids.tapY, 18],
      ];
      for (const [id, v] of want) {
        const a = get(r, id);
        expect(a.state, JSON.stringify(a)).toBe('ok');
        expect(a.value, id).toBeCloseTo(v, 9);
      }
      close(point(get(r, ids.csX).anchors?.[1]), [30, 18, 14]);
      // Edit upstream: plate_t 18 and cs_d 13 move the rim up and out; the centre stays.
      const r2 = await regen(toStage(P, doc, { plate_t: 18, cs_d: 13 }));
      allOk(r2);
      for (const [id, v] of want) expect(get(r2, id).value, id).toBeCloseTo(v, 9);
      close(point(get(r2, ids.csX).anchors?.[1]), [30, 18, 18]);
      const r3 = await regen(toStage(P, doc, { tap_x0: -32 }));
      expect(get(r3, ids.tapX).value).toBeCloseTo(32, 9);
    }, 120_000);
  });

  describe('M4.1 SECTION: faces measured in section views', () => {
    it('rp09 hub (hub_h) = 30 between the flange top and the hub top; stage 4 → 45', async () => {
      const P = partDef('rp09');
      const doc = buildDoc(P);
      const hub = stepId(P, doc, 'hub');
      const prof = stepId(P, doc, 'prof_sk');
      const H = fid('M1HH');
      part(doc).annotations = [
        {
          id: H,
          kind: 'linear',
          origin: model,
          refs: [face(`F${hub}:side(S${prof}:e(L3))`), face(`F${hub}:side(S${prof}:e(L5))`)],
        },
      ];
      const r = await regen(doc);
      allOk(r);
      expect(get(r, H).state).toBe('ok');
      expect(get(r, H).value).toBeCloseTo(30, 9);
      expect(planeZ(get(r, H).anchors?.[0])).toBeCloseTo(12, 9);
      expect(planeZ(get(r, H).anchors?.[1])).toBeCloseTo(42, 9);
      const r2 = await regen(toStage(P, doc, { hub_h: 45, bore_d: 36 }));
      allOk(r2);
      expect(get(r2, H).value).toBeCloseTo(45, 9);
    }, 120_000);

    it('rp08 tapped hole (tap_depth) = 12 from the top to its floor; plate_t 18 keeps it', async () => {
      const P = partDef('rp08');
      const doc = buildDoc(P);
      const base = stepId(P, doc, 'base');
      const pts = stepId(P, doc, 'pts_sk');
      const tap = stepId(P, doc, 'h_tap');
      const T = fid('M1TD');
      part(doc).annotations = [
        {
          id: T,
          kind: 'linear',
          origin: model,
          refs: [face(`F${base}:end`), face(`F${tap}:hole(S${pts}:p(TP)):bottom`)],
        },
      ];
      const r = await regen(doc);
      allOk(r);
      expect(get(r, T).state).toBe('ok');
      expect(get(r, T).value).toBeCloseTo(12, 9);
      expect(planeZ(get(r, T).anchors?.[1])).toBeCloseTo(2, 9);
      const r2 = await regen(toStage(P, doc, { plate_t: 18 }));
      allOk(r2);
      expect(get(r2, T).value).toBeCloseTo(12, 9);
      expect(planeZ(get(r2, T).anchors?.[1])).toBeCloseTo(6, 9);
    }, 120_000);

    it('rp05 drafted walls: the natural separation is the wall (3; stage 2 → 4); the draft angle is 3° (stage 3 → 5°)', async () => {
      const P = partDef('rp05');
      const doc = buildDoc(P);
      const base = stepId(P, doc, 'base');
      const sk = stepId(P, doc, 'base_sk');
      const sh = stepId(P, doc, 'sh');
      const wallFace = (l: string) => `F${base}:side(S${sk}:e(${l}))`;
      const WALL = fid('M1W');
      const ANGLE = ['L1', 'L2', 'L3', 'L4'].map((l) => fid(`M1D${l}`));
      const NORMALS = fid('M1DN');
      const neutral = face(`F${base}:start`);
      part(doc).annotations = [
        {
          id: WALL,
          kind: 'linear',
          origin: model,
          refs: [face(wallFace('L2')), face(`F${sh}:shell(${wallFace('L2')})`)],
        },
        ...['L1', 'L2', 'L3', 'L4'].map(
          (l, i): Annotation => ({
            id: ANGLE[i] as Id,
            kind: 'angle',
            origin: model,
            refs: [face(wallFace(l)), neutral],
            at: ['self', 'axis'],
          }),
        ),
        // Between the outward normals instead: 90° + the draft.
        {
          id: NORMALS,
          kind: 'angle',
          origin: model,
          refs: [face(wallFace('L2')), neutral],
        },
      ];
      const deg = Math.PI / 180;
      const r = await regen(doc);
      allOk(r);
      const w = get(r, WALL);
      expect(w.state, JSON.stringify(w)).toBe('ok');
      expect(w.value).toBeCloseTo(3, 9);
      for (const id of ANGLE) {
        const a = get(r, id);
        expect(a.state, JSON.stringify(a)).toBe('ok');
        expect(a.value, id).toBeCloseTo(3 * deg, 12);
      }
      // The neutral face at `axis` is still anchored as the face (the layout draws its normal).
      const n = get(r, ANGLE[1] as Id).anchors?.[1];
      if (n?.kind !== 'plane') throw new Error(`plane anchor: ${JSON.stringify(n)}`);
      close(n.normal, [0, 0, -1], 12);
      expect(get(r, NORMALS).value).toBeCloseTo(93 * deg, 12);

      // Edit upstream: wall 4, then draft_a 5°.
      const r2 = await regen(toStage(P, doc, { wall: 4 }));
      allOk(r2);
      expect(get(r2, WALL).value).toBeCloseTo(4, 9);
      expect(get(r2, ANGLE[1] as Id).value).toBeCloseTo(3 * deg, 12);
      const r3 = await regen(toStage(P, doc, { draft_a: 5 }));
      allOk(r3);
      for (const id of ANGLE) expect(get(r3, id).value, id).toBeCloseTo(5 * deg, 12);
      expect(get(r3, WALL).value).toBeCloseTo(3, 9);
    }, 120_000);
  });

  describe('M4.1 EXTREMES: min / max along the direction (rp09 flange_d)', () => {
    it('the rim across is 120 (face or edge); a plane or no direction is unmeasurable, with the reason', async () => {
      const P = partDef('rp09');
      const doc = buildDoc(P);
      const hub = stepId(P, doc, 'hub');
      const prof = stepId(P, doc, 'prof_sk');
      const s = (l: string) => `F${hub}:side(S${prof}:e(${l}))`;
      const rimEdge: EntityRef = {
        name: `edge(${[s('L1'), s('L2')].sort().join('|')})`,
        kind: 'edge',
      };
      const ids = {
        face: fid('M1XF'),
        edge: fid('M1XE'),
        y: fid('M1XY'),
        boreToRim: fid('M1XB'),
        plane: fid('M1XP'),
        noDir: fid('M1XN'),
        aligned: fid('M1XA'),
      };
      const across = (id: Id, ref: EntityRef, direction: [number, number, number]): Annotation => ({
        id,
        kind: 'linear',
        origin: model,
        refs: [ref, ref],
        at: ['min', 'max'],
        direction,
      });
      part(doc).annotations = [
        across(ids.face, face(s('L2')), [1, 0, 0]),
        across(ids.edge, rimEdge, [1, 0, 0]),
        across(ids.y, face(s('L2')), [0, 1, 0]),
        {
          id: ids.boreToRim,
          kind: 'linear',
          origin: model,
          refs: [face(s('L6')), face(s('L2'))],
          at: ['max', 'max'],
          direction: [1, 0, 0],
        },
        across(ids.plane, face(s('L3')), [1, 0, 0]),
        {
          id: ids.noDir,
          kind: 'linear',
          origin: model,
          refs: [face(s('L2')), face(s('L2'))],
          at: ['min', 'max'],
        },
        {
          id: ids.aligned,
          kind: 'aligned',
          origin: model,
          refs: [rimEdge, rimEdge],
          at: ['min', 'max'],
        },
      ];
      const r = await regen(doc);
      allOk(r);
      for (const id of [ids.face, ids.edge, ids.y]) {
        const a = get(r, id);
        expect(a.state, JSON.stringify(a)).toBe('ok');
        expect(a.value, id).toBeCloseTo(120, 9);
      }
      // The face's extremes are the middle of its tangent lines; the edge's on the circle.
      close(point(get(r, ids.face).anchors?.[0]), [-60, 0, 6]);
      close(point(get(r, ids.face).anchors?.[1]), [60, 0, 6]);
      close(point(get(r, ids.edge).anchors?.[0]), [-60, 0, 0]);
      close(point(get(r, ids.edge).anchors?.[1]), [60, 0, 0]);
      close(point(get(r, ids.y).anchors?.[1]), [0, 60, 6]);
      expect(get(r, ids.boreToRim).value).toBeCloseTo(60 - 16, 9);

      const pl = get(r, ids.plane);
      expect(pl.state).toBe('needsAttention');
      expect(pl.value).toBeUndefined();
      expect(pl.unresolved).toBeUndefined();
      expect(pl.error?.message).toMatch(/flat face has no extreme point/);
      // Anchored as the face itself.
      expect(pl.anchors?.[0]?.kind).toBe('plane');
      for (const id of [ids.noDir, ids.aligned]) {
        const a = get(r, id);
        expect(a.state, id).toBe('needsAttention');
        expect(a.value).toBeUndefined();
        expect(a.error?.message).toMatch(/needs a linear or ordinate dimension with a direction/);
      }

      // Edit upstream: flange_d 130.
      const r2 = await regen(toStage(P, doc, { flange_d: 130 }));
      allOk(r2);
      for (const id of [ids.face, ids.edge, ids.y])
        expect(get(r2, id).value, id).toBeCloseTo(130, 9);
    }, 120_000);
  });

  describe('M4.1 OUTLINE-SPLINE: torus radii (rp02 fillet_r)', () => {
    it('a radius on the fillet’s torus face is its minor radius (3; stage 3 → 4), anchored as a torus', async () => {
      const P = partDef('rp02');
      const doc = buildDoc(P);
      const shaft = stepId(P, doc, 'shaft');
      const prof = stepId(P, doc, 'prof_sk');
      const fil = stepId(P, doc, 'fil');
      const s = (l: string) => `F${shaft}:side(S${prof}:e(${l}))`;
      const torus = face(`F${fil}:fillet(edge(${[s('L3'), s('L4')].sort().join('|')}))`);
      const R = fid('M1TR');
      const D = fid('M1TD');
      const SRC = fid('M1TS');
      part(doc).annotations = [
        { id: R, kind: 'radius', origin: model, refs: [torus] },
        { id: D, kind: 'diameter', origin: model, refs: [torus] },
        {
          id: SRC,
          kind: 'radius',
          origin: model,
          refs: [torus],
          source: { kind: 'featureField', featureId: fil, path: '/radius' },
        },
      ];
      const r = await regen(doc);
      allOk(r);
      const a = get(r, R);
      expect(a.state, JSON.stringify(a)).toBe('ok');
      expect(a.value).toBeCloseTo(3, 9);
      expect(get(r, D).value).toBeCloseTo(6, 9);
      expect(get(r, SRC).value).toBeCloseTo(3, 12);
      expect(get(r, SRC).measured).toBeCloseTo(3, 9);
      const t = a.anchors?.[0];
      if (t?.kind !== 'torus') throw new Error(`torus anchor: ${JSON.stringify(t)}`);
      // The corner at (d2/2, l1) = (15, 15): the tube's centre circle is 3 out and 3 up from it.
      close(t.center, [0, 0, 18]);
      close(t.axis, [0, 0, 1]);
      expect(t.major).toBeCloseTo(18, 9);
      expect(t.minor).toBeCloseTo(3, 9);

      // The query the drawing makes for a spline outline pick: radius → the torus; plain → the face.
      const q = await api.annotationAnchors(part(doc).id, [
        { ref: torus, annotationKind: 'radius' },
        { ref: torus },
      ]);
      if (!q.ok) throw new Error(JSON.stringify(q.error));
      expect(q.value[0]?.anchor?.kind).toBe('torus');
      expect(q.value[1]?.anchor?.kind).toBe('point');

      // Edit upstream: l2 55 and fillet_r 4.
      const r2 = await regen(toStage(P, doc, { l2: 55, fillet_r: 4 }));
      allOk(r2);
      expect(get(r2, R).value).toBeCloseTo(4, 9);
      expect(get(r2, SRC).measured).toBeCloseTo(4, 9);
      const t2 = get(r2, R).anchors?.[0];
      if (t2?.kind !== 'torus') throw new Error('torus');
      expect(t2.minor).toBeCloseTo(4, 9);
      expect(t2.major).toBeCloseTo(19, 9);
      close(t2.center, [0, 0, 19]);
    }, 120_000);
  });
});
