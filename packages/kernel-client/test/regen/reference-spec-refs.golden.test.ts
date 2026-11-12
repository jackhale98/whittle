/**
 * Regen golden (M4.1 workstream D): the entity refs the reference-part specs give their drawing
 * dimensions (`DrawingDimSpec.refs`, packages/test-fixtures) resolve on the real kernel to the
 * value the spec prints, and follow parameter edits. The refs are the ones the drawing tools store;
 * the part builds with `buildDoc`, so a spec that names an entity the model does not have (a
 * level the part never had, a centre it has no point for) fails here, not in the browser.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationResolution,
  EntityRef,
  Id,
  Vec3,
  WrenDoc,
} from '@wren-cad/contracts';
import {
  baselineDims,
  buildDoc,
  type DrawingDimSpec,
  type DrawingViewSpec,
  PARTS,
  type PartDef,
  specFor,
  stageDoc,
} from '@wren-cad/test-fixtures/reference-parts';
import { describe, expect, it } from 'vitest';
import type { RegenOutput } from '../../src/regen/engine';
import { type Api, describeFailures, fid, m3Kernel, part, states } from './helpers';

const m3 = await m3Kernel();
const note = m3 ? '' : ' — SKIPPED: no kernel with the M3 features (feature check)';
const DEG = Math.PI / 180;

/** The feature id of each step of a part, by step id (`buildDoc` makes one feature per step). */
function stepIds(p: PartDef, doc: WrenDoc): Map<string, Id> {
  const dims = baselineDims(p);
  const steps = p.steps((n) => dims[n] as number);
  return new Map(steps.map((s, i) => [s.id, part(doc).features[i]?.id as Id]));
}

const WORLD: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** The annotation a drawing tool would store for a spec dimension with refs. */
function annotationFor(
  d: DrawingDimSpec,
  view: DrawingViewSpec,
  ids: Map<string, Id>,
  id: Id,
): Annotation {
  const name = (s: string): string =>
    s.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, step: string) => {
      const v = ids.get(step);
      if (v === undefined) throw new Error(`${d.name}: unknown step {${step}}`);
      return v;
    });
  const refs: EntityRef[] = (d.refs ?? []).map((r) => ({ name: name(r.name), kind: r.kind }));
  const at = (d.refs ?? []).map((r) => r.at ?? 'self');
  const withAt = at.some((a) => a !== 'self') ? { at } : {};
  const base = { id, origin: { kind: 'model' } as const, refs, ...withAt };
  if (d.kind === 'linear') {
    if (d.axis === undefined) return { ...base, kind: 'linear' };
    const letter = (d.axis === 'h' ? view.axes[0] : view.axes[1]).replace('-', '');
    return { ...base, kind: 'linear', direction: WORLD[letter] as Vec3 };
  }
  if (d.kind === 'angle') return { ...base, kind: 'angle' };
  if (d.kind === 'diameter') return { ...base, kind: 'diameter' };
  if (d.kind === 'radius') return { ...base, kind: 'radius' };
  throw new Error(`${d.name}: no annotation for kind ${d.kind}`);
}

function get(r: RegenOutput, id: string): AnnotationResolution {
  const a = r.annotations?.find((x) => x.annotationId === id);
  if (!a) throw new Error(`no resolution for ${id}: ${JSON.stringify(r.annotations)}`);
  return a;
}

/** What the resolver should give for a printed spec value (angles come back in radians). */
const expected = (d: DrawingDimSpec): number =>
  d.kind === 'angle' ? d.value * DEG : Math.abs(d.value);

describe.skipIf(!m3)(
  `reference-part specs: dimension refs resolve to the printed values${note}`,
  () => {
    const api = m3 as Api;
    const regen = (doc: WrenDoc) =>
      api.regenerate({ doc, partId: part(doc).id, quality: 'coarse', massProperties: false });

    /** The baseline document with an annotation for every spec dimension that has refs. */
    function annotated(p: PartDef): { doc: WrenDoc; dims: { d: DrawingDimSpec; id: Id }[] } {
      const spec = specFor(p);
      const doc = buildDoc(p);
      const ids = stepIds(p, doc);
      const dims = spec.drawing.dimensions
        .filter((d) => d.refs !== undefined)
        .map((d, i) => ({ d, id: fid(`SR${p.no}${i}`) }));
      part(doc).annotations = dims.map(({ d, id }) =>
        annotationFor(
          d,
          spec.drawing.views.find((v) => v.id === d.view) as DrawingViewSpec,
          ids,
          id,
        ),
      );
      return { doc, dims };
    }

    /** The document with parameters edited as at a stage (same ids, same annotations). */
    function edited(p: PartDef, doc: WrenDoc, set: Record<string, number>): WrenDoc {
      const next = structuredClone(doc);
      next.params = stageDoc(p, set).params;
      return next;
    }

    const withRefs = PARTS.filter((p) => specFor(p).drawing.dimensions.some((d) => d.refs));

    it('every dimension that was a product gap and has known entities carries refs', () => {
      const names = withRefs.flatMap((p) =>
        specFor(p)
          .drawing.dimensions.filter((d) => d.refs)
          .map((d) => `${p.id.slice(0, 4)}.${d.name}`),
      );
      expect(names.sort()).toEqual(
        [
          'rp02.fillet_r',
          'rp03.flat_h',
          'rp04.boss_up',
          'rp05.draft_a',
          'rp05.wall',
          'rp08.cs_x',
          'rp08.cs_y',
          'rp08.tap_depth',
          'rp09.flange_d',
          'rp09.hub_h',
          'rp09.pcd',
          'rp10.slot_x0',
        ].sort(),
      );
    });

    it.each(withRefs.map((p) => [p.id, p] as const))(
      '%s: each dimension with refs resolves to its printed value, and needs no attention',
      async (_id, p) => {
        const { doc, dims } = annotated(p);
        const r = await regen(doc);
        expect(states(r), describeFailures(r)).toEqual(r.features.map(() => 'ok'));
        for (const { d, id } of dims) {
          const a = get(r, id);
          expect(a.state, `${d.name}: ${JSON.stringify(a)}`).toBe('ok');
          expect(a.value, `${d.name} value`).toBeCloseTo(expected(d), 9);
        }
      },
      120_000,
    );

    it('rp04 boss_up is measured from the reference plane boss_lvl (z = 36) to the boss top and follows the parameters', async () => {
      const p = PARTS.find((x) => x.id.startsWith('rp04')) as PartDef;
      const { doc, dims } = annotated(p);
      const up = dims.find((x) => x.d.name === 'boss_up') as { d: DrawingDimSpec; id: Id };
      expect(up.d.refs?.[0]?.name).toBe('F{boss_lvl}:plane');
      const r = await regen(doc);
      expect(get(r, up.id).value).toBeCloseTo(6, 9);
      // The plane is `plate_t + boss_h - boss_up` above XY: 16 + 26 - 6.
      const plane = get(r, up.id).anchors?.[0];
      if (plane?.kind !== 'plane') throw new Error(`plane anchor: ${JSON.stringify(plane)}`);
      expect(plane.origin[2]).toBeCloseTo(36, 9);
      // Stage 3 (boss_d 36, boss_h 30, boss_up 10): the level stays at 36, the distance is 10.
      const r3 = await regen(edited(p, doc, { boss_d: 36, boss_h: 30, boss_up: 10 }));
      expect(get(r3, up.id).value).toBeCloseTo(10, 9);
      // plate_t 20: the boss top and the plane rise together; the distance stays 6.
      const r4 = await regen(edited(p, doc, { plate_t: 20 }));
      expect(get(r4, up.id).value).toBeCloseTo(6, 9);
      // boss_up 8 alone (boss_h kept): the plane drops to 34 and the distance is 8.
      const r5 = await regen(edited(p, doc, { boss_up: 8 }));
      expect(get(r5, up.id).value).toBeCloseTo(8, 9);
    }, 120_000);

    it('rp10 slot_x0 is measured from origin:Y to the construction point SC, and follows slot_x0', async () => {
      const p = PARTS.find((x) => x.id.startsWith('rp10')) as PartDef;
      const { doc, dims } = annotated(p);
      const x0 = dims.find((x) => x.d.name === 'slot_x0') as { d: DrawingDimSpec; id: Id };
      expect(x0.d.refs?.map((r) => r.name)).toEqual(['origin:Y', 'S{slot_sk}:p(SC)']);
      const r = await regen(doc);
      expect(get(r, x0.id).value).toBeCloseTo(45, 9);
      const r2 = await regen(edited(p, doc, { slot_x0: -50 }));
      expect(states(r2), describeFailures(r2)).toEqual(r2.features.map(() => 'ok'));
      expect(get(r2, x0.id).value).toBeCloseTo(50, 9);
    }, 120_000);
  },
);
