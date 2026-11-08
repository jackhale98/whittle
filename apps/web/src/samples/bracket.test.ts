/** The demo bracket loads into the store and regenerates with the real engine (Node). */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDocumentStore } from '@whittle/document';
import type { KernelInitModule } from '@whittle/kernel';
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
});
