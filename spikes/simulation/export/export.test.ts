/**
 * Spike S0, step 1: export Wren geometry for meshing. Runs the real regen engine (Node, the real
 * single-threaded kernel from packages/kernel/dist) on
 *   - the demo bracket (apps/web/src/samples/bracket.ts), and
 *   - a slender cantilever beam (L x b x h, sketch rectangle + extrude), for the analytic check,
 * and writes, per part, into spikes/simulation/out/<part>/:
 *   part.brep, part.step       the exact B-rep (the kernel's exportPart)
 *   faces.json                 TopExp-ordered faces: persistent name + fingerprint (area, centroid,
 *                              normal) so the mesher can verify its face tags geometrically
 *   material.json              the part's material (E, nu, density as Wren stores them)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { demoBracket } from '../../../apps/web/src/samples/bracket';
import type { WrenDoc } from '../../../packages/contracts/src/index';
import { materialFromLibrary, newDoc, ulid } from '../../../packages/document/src/index';
import type { KernelInitModule } from '../../../packages/kernel/src/index';
import { createModelingApi } from '../../../packages/kernel-client/src/modeling-api';

const dist = fileURLToPath(new URL('../../../packages/kernel/dist/', import.meta.url));
const out = fileURLToPath(new URL('../out/', import.meta.url));

/** Cantilever: L = 250 mm along x, b = 10 mm (y), h = 10 mm (z, extrude direction). */
export const BEAM = { L: 250, b: 10, h: 10 };

function beamDoc(): WrenDoc {
  const doc = newDoc({ name: 'Cantilever' });
  const S = ulid();
  const E = ulid();
  const pts: [string, number, number][] = [
    ['a', 0, 0],
    ['b', BEAM.L, 0],
    ['c', BEAM.L, BEAM.b],
    ['d', 0, BEAM.b],
  ];
  const entities = [
    ...pts.map(([id, x, y]) => ({ id, kind: 'point' as const, x, y, construction: false })),
    ...(
      [
        ['L1', 'a', 'b'],
        ['L2', 'b', 'c'],
        ['L3', 'c', 'd'],
        ['L4', 'd', 'a'],
      ] as const
    ).map(([id, start, end]) => ({ id, kind: 'line' as const, start, end, construction: false })),
  ];
  const constraints = pts.map(([id], i) => ({ id: `k${i}`, kind: 'fix' as const, entity: id }));
  const material = materialFromLibrary('whittle:aluminium-6061-t6');
  return {
    ...doc,
    parts: [
      {
        id: ulid(),
        name: 'Beam',
        features: [
          {
            id: S,
            type: 'sketch',
            name: 'Beam sketch',
            suppressed: false,
            on: { name: 'origin:XY', kind: 'face' },
            entities,
            constraints,
          },
          {
            id: E,
            type: 'extrude',
            name: 'Beam',
            suppressed: false,
            profile: [{ name: `S${S}:region(L1,L2,L3,L4)`, kind: 'region' }],
            direction: 'normal',
            end: { kind: 'blind', depth: `${BEAM.h} mm` },
            op: 'new',
          },
        ],
        rollbackIndex: 2,
        ...(material ? { material } : {}),
      },
    ],
  } as WrenDoc;
}

describe('S0 export', () => {
  it('exports the bracket and the cantilever with persistent face names', async () => {
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
    const info = await api.init({ variant: 'single' });
    expect(info.ok).toBe(true);
    for (const [key, doc] of [
      ['bracket', demoBracket()],
      ['beam', beamDoc()],
    ] as const) {
      const part = doc.parts[0];
      if (!part) throw new Error('no part');
      const r = await api.regenerate({ doc, partId: part.id, quality: 'coarse', massProperties: true });
      expect(r.features.every((f) => f.state === 'ok')).toBe(true);
      const body = r.bodies[0];
      if (!body) throw new Error('no body');
      const fp = await api.fingerprints(body.shape);
      if (!fp.ok) throw new Error(JSON.stringify(fp.error));
      const names = body.mesh.faceNames;
      expect(names.length).toBe(fp.value.faces.length);
      expect(names.every((n) => n.length > 0)).toBe(true);
      const dir = `${out}${key}/`;
      mkdirSync(dir, { recursive: true });
      for (const fmt of ['brep', 'step'] as const) {
        const e = await api.exportPart(part.id, fmt);
        if (!e.ok) throw new Error(JSON.stringify(e.error));
        writeFileSync(`${dir}part.${fmt}`, e.bytes);
      }
      const faces = fp.value.faces.map((f, i) => ({ index: i, name: names[i], ...f }));
      writeFileSync(
        `${dir}faces.json`,
        JSON.stringify(
          {
            part: part.name,
            kernel: info.ok ? info.value : null,
            volume: body.massProperties?.volume,
            area: body.massProperties?.area,
            faces,
          },
          null,
          1,
        ),
      );
      writeFileSync(`${dir}material.json`, JSON.stringify(part.material ?? null, null, 1));
      await api.closePart(part.id);
    }
  });
});
