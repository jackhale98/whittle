/**
 * The fake ModelingApi against the real kernel in Node (createKernelApi, single-threaded build).
 * Skipped when packages/kernel/dist is missing.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Feature, RegenResult, SketchFeature, WhittleDoc } from '@whittle/contracts';
import { newDoc, ulid } from '@whittle/document';
import type { KernelInitModule } from '@whittle/kernel';
import { createKernelApi } from '@whittle/kernel-client/kernel-api';
import { rectangleCornerTool } from '@whittle/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFakeModeling } from './fake-modeling';

const dist = fileURLToPath(new URL('../../../../packages/kernel/dist/', import.meta.url));
const built = existsSync(`${dist}init.single.js`);
const PART = ulid();

function docWith(features: Feature[], rollbackIndex = features.length): WhittleDoc {
  const doc = newDoc({ name: 'Test', firstPart: 'Part 1' });
  const part = doc.parts[0];
  if (!part) throw new Error('no part');
  part.id = PART;
  part.features = features;
  part.rollbackIndex = rollbackIndex;
  return doc;
}

function rectSketch(id = ulid(), w = 40, h = 30): SketchFeature {
  const frag = rectangleCornerTool([0, 0], [w, h]);
  return {
    id,
    type: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    on: { name: 'origin:XY', kind: 'face' },
    entities: frag.entities,
    constraints: frag.constraints,
  };
}

describe.skipIf(!built)('fake ModelingApi over the real kernel', () => {
  let fake: ReturnType<typeof createFakeModeling>;

  beforeAll(async () => {
    const api = createKernelApi({
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
    fake = createFakeModeling(api);
  }, 60_000);

  async function regen(doc: WhittleDoc): Promise<RegenResult> {
    const partId = doc.parts[0]?.id ?? '';
    return fake.regenerate({ doc, partId, quality: 'coarse', massProperties: true });
  }

  it('sketch → region → extrude → fillet, with names, mass and caching', async () => {
    const sketch = rectSketch();
    let doc = docWith([sketch]);
    const r1 = await regen(doc);
    expect(r1.features.map((s) => s.state)).toEqual(['ok']);
    const region = r1.sketches[0]?.regions[0];
    expect(region?.name).toMatch(new RegExp(`^S${sketch.id}:region\\(`));
    expect(r1.sketches[0]?.curves).toHaveLength(4);
    expect(r1.sketches[0]?.points).toHaveLength(4);

    const extrude: Feature = {
      id: ulid(),
      type: 'extrude',
      name: 'Extrude 1',
      suppressed: false,
      profile: [{ name: region?.name ?? '', kind: 'region' }],
      direction: 'normal',
      end: { kind: 'blind', depth: 'width / 4' },
      op: 'new',
    };
    doc = docWith([sketch, extrude]);
    doc.params.push({ id: ulid(), name: 'width', expr: '40mm' });
    const r2 = await regen(doc);
    expect(r2.revision).toBeGreaterThan(r1.revision);
    expect(r2.features.map((s) => s.state)).toEqual(['ok', 'ok']);
    expect(r2.features[0]?.cached).toBe(true);
    expect(r2.bodies).toHaveLength(1);
    const body = r2.bodies[0];
    expect(body?.id).toBe(`B${extrude.id}`);
    expect(body?.massProperties?.volume).toBeCloseTo(40 * 30 * 10, 3);
    expect(body?.mesh.faceRanges.length).toBe(12); // 6 faces

    // Selection → persistent reference.
    const edgeIndex = body?.mesh.edgeNames.findIndex((n) => n.includes(':end|')) ?? -1;
    expect(edgeIndex).toBeGreaterThanOrEqual(0);
    const ref = await fake.refFor(doc.parts[0]?.id ?? '', {
      bodyId: body?.id ?? '',
      kind: 'edge',
      index: edgeIndex,
    });
    expect(ref?.name).toBe(body?.mesh.edgeNames[edgeIndex]);
    expect(ref?.fingerprint?.length).toBeGreaterThan(0);

    const fillet: Feature = {
      id: ulid(),
      type: 'fillet',
      name: 'Fillet 1',
      suppressed: false,
      edges: [ref ?? { name: '', kind: 'edge' }],
      radius: '2mm',
    };
    doc = docWith([sketch, extrude, fillet]);
    doc.params.push({ id: ulid(), name: 'width', expr: '40mm' });
    const r3 = await regen(doc);
    expect(r3.features.map((s) => s.state)).toEqual(['ok', 'ok', 'ok']);
    expect(r3.features[1]?.cached).toBe(true);
    expect(r3.bodies[0]?.massProperties?.volume).toBeLessThan(12000);

    // Too-large radius: a human error, the body stays (previous state).
    const big = { ...fillet, radius: '50mm' };
    doc = docWith([sketch, extrude, big]);
    doc.params.push({ id: ulid(), name: 'width', expr: '40mm' });
    const r4 = await regen(doc);
    expect(r4.features[2]?.state).toBe('error');
    expect(r4.features[2]?.error?.message).toMatch(/too large/);
    expect(r4.bodies[0]?.massProperties?.volume).toBeCloseTo(12000, 3);

    // Rolled back / suppressed / unknown param.
    const r5 = await regen(docWith([sketch, extrude, fillet], 2));
    expect(r5.features.map((s) => s.state)).toEqual(['ok', 'error', 'rolledBack']);
    expect(r5.features[1]?.error?.message).toMatch(/width/);
    const r6 = await regen(
      docWith([
        sketch,
        { ...extrude, end: { kind: 'blind', depth: '5' } },
        { ...fillet, suppressed: true },
      ]),
    );
    expect(r6.features.map((s) => s.state)).toEqual(['ok', 'ok', 'suppressed']);

    // Missing reference: never guessed.
    const lost = { ...fillet, edges: [{ name: 'edge(nope|nada)', kind: 'edge' as const }] };
    const r7 = await regen(
      docWith([sketch, { ...extrude, end: { kind: 'blind', depth: '5' } }, lost]),
    );
    expect(r7.features[2]?.state).toBe('needsAttention');
    expect(r7.features[2]?.unresolved?.[0]?.path).toBe('/edges/0');

    // Export.
    const stl = await fake.exportPart(doc.parts[0]?.id ?? '', 'stl', { stlBinary: true });
    expect(stl.ok).toBe(true);
    if (stl.ok) expect(stl.bytes.byteLength).toBeGreaterThan(84);
  }, 60_000);

  it('dependent features are blocked when an upstream feature fails', async () => {
    const sketch = rectSketch();
    const r0 = await regen(docWith([sketch]));
    const name = r0.sketches[0]?.regions[0]?.name ?? '';
    const ex: Feature = {
      id: ulid(),
      type: 'extrude',
      name: 'Extrude 1',
      suppressed: false,
      profile: [{ name, kind: 'region' }],
      direction: 'normal',
      end: { kind: 'blind', depth: '0mm' },
      op: 'new',
    };
    const fil: Feature = {
      id: ulid(),
      type: 'fillet',
      name: 'Fillet 1',
      suppressed: false,
      edges: [{ name: `edge(F${ex.id}:end|F${ex.id}:side(S${sketch.id}:e(x)))`, kind: 'edge' }],
      radius: '1mm',
    };
    const r = await regen(docWith([sketch, ex, fil]));
    expect(r.features.map((s) => s.state)).toEqual(['ok', 'error', 'blocked']);
  }, 60_000);
});
