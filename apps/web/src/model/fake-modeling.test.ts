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

  it('revolve about an origin axis, chamfer, datum plane sketches and booleans', async () => {
    // Revolve: a 10 × 10 square on Front (XZ), 10 mm off the Z axis → a tube.
    const front: SketchFeature = { ...rectSketch(), on: { name: 'origin:XZ', kind: 'face' } };
    front.entities = rectangleCornerTool([10, 0], [20, 10]).entities;
    front.constraints = [];
    const r0 = await regen(docWith([front]));
    const ring = r0.sketches[0]?.regions[0]?.name ?? '';
    const rev: Feature = {
      id: ulid(),
      type: 'revolve',
      name: 'Revolve 1',
      suppressed: false,
      profile: [{ name: ring, kind: 'region' }],
      axis: { name: 'origin:Z', kind: 'edge' },
      angle: '360 deg',
      direction: 'normal',
      op: 'new',
    };
    const r1 = await regen(docWith([front, rev]));
    expect(r1.features.map((f) => f.state)).toEqual(['ok', 'ok']);
    expect(r1.bodies[0]?.massProperties?.volume).toBeCloseTo(Math.PI * (400 - 100) * 10, 1);

    // Datum plane 15 mm above Top, a sketch on it, extruded: the body starts at z = 15.
    const plane: Feature = {
      id: ulid(),
      type: 'plane',
      name: 'Plane 1',
      suppressed: false,
      definition: { kind: 'offset', from: { name: 'origin:XY', kind: 'face' }, distance: '15 mm' },
    };
    const onPlane: SketchFeature = {
      ...rectSketch(),
      on: { name: `F${plane.id}:plane`, kind: 'face' },
    };
    const r2 = await regen(docWith([plane, onPlane]));
    expect(r2.sketches[0]?.frame.origin[2]).toBeCloseTo(15);
    const ex: Feature = {
      id: ulid(),
      type: 'extrude',
      name: 'Extrude 1',
      suppressed: false,
      profile: [{ name: r2.sketches[0]?.regions[0]?.name ?? '', kind: 'region' }],
      direction: 'normal',
      end: { kind: 'blind', depth: '5 mm' },
      op: 'new',
    };
    const r3 = await regen(docWith([plane, onPlane, ex]));
    expect(r3.bodies[0]?.mesh.bbox.min[2]).toBeCloseTo(15, 3);

    // Two boxes, cut one with the other; then chamfer an edge of the result.
    const a: Feature = {
      id: ulid(),
      type: 'primitive',
      name: 'Box 1',
      suppressed: false,
      op: 'new',
      shape: 'box',
      dx: '20',
      dy: '20',
      dz: '20',
    };
    const b: Feature = {
      ...a,
      id: ulid(),
      name: 'Box 2',
      frame: { origin: [10, 10, 10], z: [0, 0, 1], x: [1, 0, 0] },
    };
    const cut: Feature = {
      id: ulid(),
      type: 'boolean',
      name: 'Boolean 1',
      suppressed: false,
      op: 'cut',
      target: { name: `B${a.id}`, kind: 'body' },
      tools: [{ name: `B${b.id}`, kind: 'body' }],
      keepTools: false,
    };
    const r4 = await regen(docWith([a, b, cut]));
    expect(r4.features.map((f) => f.state)).toEqual(['ok', 'ok', 'ok']);
    expect(r4.bodies).toHaveLength(1);
    expect(r4.bodies[0]?.massProperties?.volume).toBeCloseTo(8000 - 1000, 3);
    const edge = r4.bodies[0]?.mesh.edgeNames.find((n) => n.length > 0) ?? '';
    const ch: Feature = {
      id: ulid(),
      type: 'chamfer',
      name: 'Chamfer 1',
      suppressed: false,
      edges: [{ name: edge, kind: 'edge' }],
      mode: { kind: 'distance', distance: '1 mm' },
    };
    const r5 = await regen(docWith([a, b, cut, ch]));
    expect(r5.features[3]?.state).toBe('ok');
    expect(r5.bodies[0]?.massProperties?.volume).toBeLessThan(7000);
  }, 60_000);
});
