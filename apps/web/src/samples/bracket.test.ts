/** The demo bracket loads into the store and regenerates with the real engine (Node). */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDocumentStore } from '@wren-cad/document';
import type { KernelInitModule } from '@wren-cad/kernel';
import { describe, expect, it } from 'vitest';
import { createModelingApi } from '../../../../packages/kernel-client/src/modeling-api';
import { demoBracket, demoBracketVolume } from './bracket';

const dist = fileURLToPath(new URL('../../../../packages/kernel/dist/', import.meta.url));
const built = existsSync(`${dist}init.single.js`);
const DIMS = {
  width: 80,
  depth: 50,
  thickness: 8,
  hole_d: 6,
  height: 40,
  corner_r: 5,
  bend_r: 3,
  chamfer_d: 2,
};

describe('demo bracket', () => {
  it('is a valid document with fresh ids per copy', () => {
    const a = demoBracket();
    const b = demoBracket();
    const store = createDocumentStore();
    expect(store.load(a).ok).toBe(true);
    expect(a.meta.id).not.toBe(b.meta.id);
    expect(a.parts[0]?.id).not.toBe(b.parts[0]?.id);
    expect(a.parts[0]?.features.map((f) => f.id)).not.toEqual(
      b.parts[0]?.features.map((f) => f.id),
    );
    expect(a.parts[0]?.material?.name).toMatch(/6061/);
  });

  it.skipIf(!built)(
    'regenerates in the real engine; width changes the volume and mass',
    async () => {
      const api = createModelingApi({
        variants: {
          single: {
            load: () =>
              import(pathToFileURL(`${dist}init.single.js`).href) as Promise<KernelInitModule>,
          },
          threaded: {
            load: () =>
              import(pathToFileURL(`${dist}init.multi.js`).href) as Promise<KernelInitModule>,
          },
        },
      });
      expect((await api.init({ variant: 'single' })).ok).toBe(true);
      const doc = demoBracket();
      const partId = doc.parts[0]?.id ?? '';
      const r = await api.regenerate({ doc, partId, quality: 'coarse', massProperties: true });
      expect(r.features.map((f) => f.state)).toEqual(Array(9).fill('ok'));
      const v = r.bodies[0]?.massProperties?.volume ?? 0;
      expect(Math.abs(v - demoBracketVolume(DIMS)) / v).toBeLessThan(1e-6);
      const mass = r.bodies[0]?.massProperties?.mass ?? 0;
      expect(mass).toBeCloseTo(v * 2.7e-6, 6); // kg, 2.70 g/cm³

      const wide = structuredClone(doc);
      const w = wide.params.find((p) => p.name === 'width');
      if (w) w.expr = '100 mm';
      const r2 = await api.regenerate({
        doc: wide,
        partId,
        quality: 'coarse',
        massProperties: true,
      });
      expect(r2.features.map((f) => f.state)).toEqual(Array(9).fill('ok'));
      const v2 = r2.bodies[0]?.massProperties?.volume ?? 0;
      expect(Math.abs(v2 - demoBracketVolume({ ...DIMS, width: 100 })) / v2).toBeLessThan(1e-6);
      await api.closePart(partId);
    },
    60_000,
  );

  it.skipIf(!built)(
    'has one back face (the upright merges into the plate) and shells 1 and 2 mm (ADR-076)',
    async () => {
      const api = createModelingApi({
        variants: {
          single: {
            load: () =>
              import(pathToFileURL(`${dist}init.single.js`).href) as Promise<KernelInitModule>,
          },
          threaded: {
            load: () =>
              import(pathToFileURL(`${dist}init.multi.js`).href) as Promise<KernelInitModule>,
          },
        },
      });
      expect((await api.init({ variant: 'single' })).ok).toBe(true);
      const doc = demoBracket();
      const part = doc.parts[0];
      if (!part) throw new Error('no part');
      const partId = part.id;
      const r = await api.regenerate({ doc, partId, quality: 'coarse', massProperties: true });
      expect(r.features.map((f) => f.state)).toEqual(Array(9).fill('ok'));
      const body = r.bodies[0];
      // Plate 6 + 4 holes + upright top, front, chamfer + bend and 2 corner fillets; the back and
      // both sides of plate and upright are one face each (19 before the merge).
      expect(body?.mesh.faceNames).toHaveLength(16);
      const fp = await api.fingerprints(body?.shape ?? 0);
      if (!fp.ok) throw new Error('fingerprints');
      const back = fp.value.faces.filter(
        (f) => f.normal?.[1] === 1 && Math.abs((f.centroid[1] ?? 0) - DIMS.depth) < 1e-6,
      );
      expect(back).toHaveLength(1);
      expect(back[0]?.area).toBeCloseTo(DIMS.width * (DIMS.thickness + DIMS.height), 6);

      // Shell with the upright's top open: analytic volume (sharp joins; the void is the body
      // eroded by t, open at the top; see packages/kernel-client/test/regen/unify.golden.test.ts).
      const upright = part.features[5];
      if (upright?.type !== 'extrude') throw new Error('upright');
      const k = 1 - Math.PI / 4;
      const voidAt = (t: number) => {
        const { width: W, depth: D, thickness: T, height: H } = DIMS;
        const c = DIMS.chamfer_d;
        const profile =
          (D - 2 * t) * (T - 2 * t) +
          (T - 2 * t) * (H + t) -
          0.5 * (c - t + t * Math.SQRT2) ** 2 +
          k * (DIMS.bend_r + t) ** 2;
        return (
          (W - 2 * t) * profile -
          2 * k * (DIMS.corner_r - t) ** 2 * (T - 2 * t) -
          4 * Math.PI * (DIMS.hole_d / 2 + t) ** 2 * (T - 2 * t)
        );
      };
      for (const t of [1, 2]) {
        const shelled = structuredClone(doc);
        const p = shelled.parts[0];
        if (!p) throw new Error('no part');
        p.features.push({
          id: `01JSHELL${t}`.padEnd(26, '0'),
          type: 'shell',
          name: 'Shell',
          suppressed: false,
          openFaces: [{ name: `F${upright.id}:end`, kind: 'face' }],
          thickness: `${t} mm`,
          direction: 'inward',
        });
        p.rollbackIndex = p.features.length;
        const s = await api.regenerate({ doc: shelled, partId, quality: 'coarse', massProperties: true });
        expect(s.features.map((f) => f.state)).toEqual(Array(10).fill('ok'));
        const v = s.bodies[0]?.massProperties?.volume ?? 0;
        const want = demoBracketVolume(DIMS) - voidAt(t);
        expect(Math.abs(v - want) / want).toBeLessThan(1e-6);
      }
      await api.closePart(partId);
    },
    60_000,
  );
});
