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
});
