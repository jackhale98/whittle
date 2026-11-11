/**
 * `ModelingApi.shapeForDrawing` (M4, ADR-090 decision 14): the BREP of a part's final shape with
 * the persistent name of every face and edge in `TopExp::MapShapes` order of that BREP, its value
 * key and cheap bounds. Round trip: the BREP read back has exactly as many faces and edges as
 * there are names, and sub-shape i of the read-back shape is the one named `faceNames[i]` /
 * `edgeNames[i]` (same fingerprint). Real kernel.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ShapeFingerprints, WrenDoc } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { bracketDoc } from './bracket';
import {
  type Api,
  built,
  describeFailures,
  extrude,
  fid,
  loadApi,
  part,
  region,
  Sk,
  skipNote,
  states,
  withParams,
} from './helpers';

const PART = fid('PART');

function closeVec(a: number[], b: number[], tol = 1e-6): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] as number)) <= tol * Math.max(1, Math.abs(v)));
}

/** The bracket plus a separate box body (two solids → a compound BREP). */
function twoBodies(): WrenDoc {
  const doc = bracketDoc();
  const S = fid('SFDS');
  const E = fid('SFDE');
  const s = new Sk();
  const r = s.rect('b', 'K', 100, 0, 120, 20, '20 mm', '20 mm');
  s.geo({ kind: 'fix', entity: r.a });
  const p = part(doc);
  p.features.push(s.feature(S), extrude(E, [region(S, 'K1,K2,K3,K4')], '15 mm', 'new'));
  p.rollbackIndex = p.features.length;
  return doc;
}

describe.skipIf(!built)(`shapeForDrawing${skipNote}`, () => {
  let api: Api;
  const regen = (doc: WrenDoc, slot?: `config:${string}`) =>
    api.regenerate({
      doc,
      partId: PART,
      quality: 'coarse',
      massProperties: false,
      ...(slot ? { slot } : {}),
    });

  async function fingerprints(shape: number): Promise<ShapeFingerprints> {
    const fp = await api.fingerprints(shape);
    if (!fp.ok) throw new Error(JSON.stringify(fp.error));
    return fp.value;
  }

  it('round trip: names match the BREP face and edge counts and order', async () => {
    api = await loadApi();
    for (const [doc, count] of [
      [bracketDoc(), 1],
      [twoBodies(), 2],
    ] as const) {
      const r = await regen(doc);
      expect(
        r.features.every((f) => f.state === 'ok'),
        describeFailures(r),
      ).toBe(true);
      expect(r.bodies).toHaveLength(count);
      const out = await api.shapeForDrawing(PART);
      if (!out.ok) throw new Error(JSON.stringify(out.error));
      const s = out.value;
      expect(s.brep.byteLength).toBeGreaterThan(1000);

      // Names in body order, primary names only, as each body's mesh lists them.
      expect(s.faceNames).toEqual(r.bodies.flatMap((b) => b.mesh.faceNames));
      expect(s.edgeNames).toEqual(r.bodies.flatMap((b) => b.mesh.edgeNames));
      expect(s.faceNames.every((n) => n.length > 0)).toBe(true);

      // Read the BREP back: one body per solid, in order; counts and fingerprints by index.
      const back = await api.importFile(s.brep, 'brep');
      if (!back.ok) throw new Error(JSON.stringify(back.error));
      expect(back.bodies).toHaveLength(r.bodies.length);
      let faces = 0;
      let edges = 0;
      for (let k = 0; k < r.bodies.length; k++) {
        const was = await fingerprints((r.bodies[k] as { shape: number }).shape);
        const now = await fingerprints((back.bodies[k] as { shape: number }).shape);
        expect(now.faces).toHaveLength(was.faces.length);
        expect(now.edges).toHaveLength(was.edges.length);
        now.faces.forEach((f, i) => {
          expect(closeVec(f.centroid, (was.faces[i] as { centroid: number[] }).centroid)).toBe(
            true,
          );
        });
        now.edges.forEach((e, i) => {
          expect(closeVec(e.centroid, (was.edges[i] as { centroid: number[] }).centroid)).toBe(
            true,
          );
        });
        faces += now.faces.length;
        edges += now.edges.length;
      }
      expect(s.faceNames).toHaveLength(faces);
      expect(s.edgeNames).toHaveLength(edges);
      for (const b of back.bodies) await api.release(b.shape);

      // Bounds: the union of the bodies' boxes.
      const min = [0, 1, 2].map((i) => Math.min(...r.bodies.map((b) => b.mesh.bbox.min[i] ?? 0)));
      const max = [0, 1, 2].map((i) => Math.max(...r.bodies.map((b) => b.mesh.bbox.max[i] ?? 0)));
      expect(closeVec(s.bounds.min, min, 1e-3)).toBe(true);
      expect(closeVec(s.bounds.max, max, 1e-3)).toBe(true);
    }
  }, 120_000);

  it('the key follows the geometry, not the slot or the annotations', async () => {
    api ??= await loadApi();
    const doc = bracketDoc();
    await regen(doc);
    const a = await api.shapeForDrawing(PART);
    await regen(doc, 'config:same');
    const same = await api.shapeForDrawing(PART, 'config:same');
    const annotated = structuredClone(doc);
    part(annotated).annotations = [
      { id: fid('SFDA'), kind: 'note', origin: { kind: 'model' }, refs: [], text: 'Deburr' },
    ];
    const r = await regen(annotated);
    expect(states(r)).toEqual(Array(9).fill('ok'));
    const b = await api.shapeForDrawing(PART);
    await regen(withParams(doc, { width: '90 mm' }));
    const c = await api.shapeForDrawing(PART);
    if (!a.ok || !same.ok || !b.ok || !c.ok) throw new Error('shapeForDrawing failed');
    expect(same.value.key).toBe(a.value.key);
    expect(b.value.key).toBe(a.value.key);
    expect(c.value.key).not.toBe(a.value.key);
    expect(c.value.bounds.max[0]).toBeCloseTo(90, 3);
  }, 120_000);

  it('refuses a slot that was never regenerated, with a message', async () => {
    api ??= await loadApi();
    const r = await api.shapeForDrawing(PART, 'config:never');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/not been regenerated/);
    const bad = await api.shapeForDrawing(PART, 'nope' as never);
    expect(bad.ok).toBe(false);
  }, 120_000);
});
