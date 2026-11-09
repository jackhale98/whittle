/**
 * M3 regen engine unit tests on a scripted fake kernel (no Wasm): the FeatureInputs the engine
 * assembles for every new feature type (refs, frames, values, tool shapes), reference geometry,
 * the tool-shape cache, linked sketch entities, hole tables and persistent naming of pattern
 * instances (count changes, `skip`), including "never guess" cases.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AxisFeature,
  CircularPatternFeature,
  EntityRef,
  Feature,
  FilletFeature,
  Frame,
  HoleFeature,
  Id,
  LinearPatternFeature,
  MirrorFeature,
  PlaneFeature,
  PointFeature,
  PrimitiveFeature,
  ShellFeature,
  SketchFeature,
  SketchSolveInput,
  SweepFeature,
  ThreadFeature,
  Vec3,
  WrenDoc,
} from '@wren-cad/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { RegenEngine, type RegenOutput } from '../../src/regen/engine';
import { FakeKernel, identitySolver } from './fake-kernel';
import { fid, makeDoc, Sk } from './helpers';

const BOX = fid('BOX');
const SK = fid('SKH');
const HOLE = fid('HOLE');
const PAT = fid('PAT');
const THR = fid('THR');
const PART = fid('PART');
const tag = (id: Id) => `F${id}`;

type BoxFeature = Extract<PrimitiveFeature, { shape: 'box' }>;

function box(id: Id = BOX, dz = '20 mm'): BoxFeature {
  return {
    id,
    type: 'primitive',
    name: 'Box',
    suppressed: false,
    op: 'new',
    shape: 'box',
    dx: '100 mm',
    dy: '50 mm',
    dz,
  };
}

const face = (name: string, extra: Partial<EntityRef> = {}): EntityRef => ({
  name,
  kind: 'face',
  ...extra,
});
const edge = (name: string): EntityRef => ({ name, kind: 'edge' });
const top = face(`${tag(BOX)}:face.zmax`);
/** The box's bottom front edge, along +X. */
const xEdge = edge(`${tag(BOX)}:edge(face.ymin|face.zmin)`);

function holeSketch(points: [string, number, number][] = [['p1', 20, 10]]): SketchFeature {
  const s = new Sk();
  for (const [id, x, y] of points) s.point(id, x, y);
  return s.feature(SK, top);
}

function hole(extra: Partial<HoleFeature> = {}, points = ['p1']): HoleFeature {
  return {
    id: HOLE,
    type: 'hole',
    name: 'Hole',
    suppressed: false,
    points: points.map((p) => ({ name: `S${SK}:p(${p})`, kind: 'vertex' })),
    face: top,
    standard: 'ISO',
    kind: 'simple',
    size: 'M6',
    fit: 'normal',
    end: { kind: 'blind', depth: '10 mm' },
    ...extra,
  };
}

function linear(extra: Partial<LinearPatternFeature> = {}): LinearPatternFeature {
  return {
    id: PAT,
    type: 'linearPattern',
    name: 'Pattern',
    suppressed: false,
    source: { kind: 'features', features: [HOLE] },
    direction: xEdge,
    reverse: false,
    count: '3',
    spacing: '25 mm',
    ...extra,
  };
}

const wallName = (p = 'p1') => `${tag(HOLE)}:hole(S${SK}:p(${p})):wall`;
const instName = (k: number, p = 'p1') => `${tag(PAT)}:inst${k}(${wallName(p)})`;

function thread(ref: EntityRef): ThreadFeature {
  return {
    id: THR,
    type: 'thread',
    name: 'Thread',
    suppressed: false,
    face: ref,
    standard: 'ISO',
    size: 'M6',
  };
}

function setup() {
  const kernel = new FakeKernel();
  const solves: SketchSolveInput[] = [];
  const solver = {
    solve: (input: SketchSolveInput) => {
      solves.push(structuredClone(input));
      return identitySolver.solve(input);
    },
  };
  const engine = new RegenEngine({ kernel: kernel.api(), sketchSolver: async () => solver });
  const regen = (features: Feature[], params: Record<string, string> = {}) =>
    engine.regenerate({ doc: makeDoc(params, features, PART), partId: PART, quality: 'coarse' });
  return { kernel, engine, regen, solves };
}

function stateOf(r: RegenOutput, id: Id) {
  return r.features.find((f) => f.featureId === id);
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected a value');
  return v;
}

function lastCall(kernel: FakeKernel, id: Id) {
  const c = kernel.callsFor(id);
  return c[c.length - 1];
}

function expectPoint(sk: SketchFeature, id: string, x: number, y: number) {
  const e = sk.entities.find((p) => p.id === id);
  expect(e?.kind).toBe('point');
  if (e?.kind !== 'point') return;
  expect(e.x).toBeCloseTo(x, 9);
  expect(e.y).toBeCloseTo(y, 9);
}

const close = (a: Vec3 | undefined, b: Vec3) => {
  expect(a).toBeDefined();
  for (let i = 0; i < 3; i++) expect((a as Vec3)[i]).toBeCloseTo(b[i] as number, 9);
};

describe('M3 engine inputs: holes', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('frames["hole:i"] on the face, z into the material; diameters from the ISO table', async () => {
    const r = await t.regen([
      box(),
      holeSketch([
        ['p1', 20, 10],
        ['p2', 40, 10],
      ]),
      hole({}, ['p1', 'p2']),
    ]);
    expect(stateOf(r, HOLE)?.state).toBe('ok');
    const c = lastCall(t.kernel, HOLE);
    expect(c?.inputs.target).toBeDefined();
    const f0 = c?.inputs.frames?.['hole:0'] as Frame;
    const f1 = c?.inputs.frames?.['hole:1'] as Frame;
    close(f0.origin, [20, 10, 20]);
    close(f1.origin, [40, 10, 20]);
    close(f0.z, [0, 0, -1]);
    expect(c?.inputs.values['/diameter']).toBe(6.6);
    expect(c?.inputs.values['/end/depth']).toBe(10);
  });

  it('explicit diameter overrides the table; counterbore and countersink come from it', async () => {
    await t.regen([box(), holeSketch(), hole({ diameter: '7 mm' })]);
    expect(lastCall(t.kernel, HOLE)?.inputs.values['/diameter']).toBe(7);
    await t.regen([box(), holeSketch(), hole({ kind: 'counterbore', fit: 'close' })]);
    const cb = lastCall(t.kernel, HOLE)?.inputs.values;
    expect(cb).toMatchObject({
      '/diameter': 6.4,
      '/counterbore/diameter': 11,
      '/counterbore/depth': 6,
    });
    await t.regen([box(), holeSketch(), hole({ kind: 'countersink', size: 'M8' })]);
    const cs = lastCall(t.kernel, HOLE)?.inputs.values;
    expect(cs?.['/countersink/diameter']).toBe(17.92);
    expect(cs?.['/countersink/angle']).toBeCloseTo(Math.PI / 2, 12);
    await t.regen([box(), holeSketch(), hole({ kind: 'tapped', standard: 'ANSI', size: '1/4' })]);
    expect(lastCall(t.kernel, HOLE)?.inputs.values['/diameter']).toBeCloseTo(0.201 * 25.4, 9);
  });

  it('a size outside the table is an error naming it; a point off the face is an error', async () => {
    const r = await t.regen([box(), holeSketch(), hole({ size: 'M7' })]);
    expect(stateOf(r, HOLE)).toMatchObject({
      state: 'error',
      error: { message: 'ISO M7 is not in the ISO hole table' },
    });
    const off = new Sk();
    off.point('p1', 20, 10);
    const offSketch = off.feature(SK, 'origin:XY'); // z = 0, not on the top face
    const r2 = await t.regen([box(), offSketch, hole()]);
    expect(stateOf(r2, HOLE)?.state).toBe('error');
    expect(stateOf(r2, HOLE)?.error?.message).toMatch(/Hole point 1 is not on the hole’s face/);
  });

  it('a hole at a point feature; a lost point needs attention with its path', async () => {
    const pt: PointFeature = {
      id: fid('PT'),
      type: 'point',
      name: 'Point',
      suppressed: false,
      definition: { kind: 'coordinates', x: '30 mm', y: '20 mm', z: '20 mm' },
    };
    const h = hole({ points: [{ name: `${tag(pt.id)}:point`, kind: 'vertex' }] });
    const r = await t.regen([box(), pt, h]);
    expect(stateOf(r, HOLE)?.state).toBe('ok');
    close(must(must(lastCall(t.kernel, HOLE)).inputs.frames?.['hole:0']).origin, [30, 20, 20]);
    const r2 = await t.regen([box(), { ...pt, suppressed: true }, h]);
    expect(stateOf(r2, HOLE)).toMatchObject({
      state: 'needsAttention',
      unresolved: [{ path: '/points/0', reason: 'missing' }],
    });
  });
});

describe('M3 engine inputs: patterns, mirror and the tool-shape cache', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('a pattern of a hole gets the hole tool solid, its op, the direction and the counts', async () => {
    const r = await t.regen([box(), holeSketch(), hole(), linear()]);
    expect(stateOf(r, PAT)?.state).toBe('ok');
    const c = lastCall(t.kernel, PAT);
    const toolHandle = c?.inputs.shapes?.[`tool:${HOLE}`];
    expect(toolHandle).toBeDefined();
    // The tool was built by the hole alone (no target).
    const toolCalls = t.kernel.callsFor(HOLE).filter((x) => x.inputs.target === undefined);
    expect(toolCalls).toHaveLength(1);
    expect(c?.inputs.values).toMatchObject({ '/count': 3, '/spacing': 25, [`/ops/${HOLE}`]: 1 });
    close(must(must(c).inputs.frames?.axis).z, [1, 0, 0]);
    // The target is the drilled body.
    const holeResult = t.kernel.calls.findIndex((x) => x.feature.id === HOLE && x.inputs.target);
    expect(holeResult).toBeGreaterThanOrEqual(0);
    const body = r.bodies.find((b) => b.id === `B${BOX}`);
    expect(body?.mesh.faceNames).toEqual(
      expect.arrayContaining([wallName(), instName(1), instName(2)]),
    );
  });

  it('editing the pattern reuses the cached tool; editing the hole rebuilds it', async () => {
    await t.regen([box(), holeSketch(), hole(), linear()]);
    const tools = () => t.kernel.callsFor(HOLE).filter((x) => x.inputs.target === undefined).length;
    expect(tools()).toBe(1);
    const r = await t.regen([box(), holeSketch(), hole(), linear({ count: '4' })]);
    expect(stateOf(r, HOLE)?.cached).toBe(true);
    expect(stateOf(r, PAT)?.cached).toBe(false);
    expect(tools()).toBe(1);
    await t.regen([box(), holeSketch(), hole({ diameter: '8 mm' }), linear({ count: '4' })]);
    expect(tools()).toBe(2);
    // A longer box changes the drilled body but not the hole's own inputs: same tool.
    const longer = { ...box(), dx: '120 mm' };
    const r2 = await t.regen([
      longer,
      holeSketch(),
      hole({ diameter: '8 mm' }),
      linear({ count: '4' }),
    ]);
    expect(stateOf(r2, SK)?.cached).toBe(true);
    expect(stateOf(r2, HOLE)?.cached).toBe(false);
    expect(tools()).toBe(2);
    // A taller box moves the top face, the sketch on it and so the hole frames: a new tool.
    await t.regen([
      box(BOX, '25 mm'),
      holeSketch(),
      hole({ diameter: '8 mm' }),
      linear({ count: '4' }),
    ]);
    expect(tools()).toBe(3);
  });

  it('instance names survive count changes and skips; removed instances need attention', async () => {
    // A thread on instance 2's wall.
    const ref = face(instName(2));
    const base = [box(), holeSketch(), hole()];
    const r1 = await t.regen([...base, linear(), thread(ref)]);
    expect(stateOf(r1, THR)?.state).toBe('ok');
    const fp = (await t.kernel.fingerprints(
      (r1.bodies.find((b) => b.id === `B${BOX}`) as { shape: number }).shape,
    )) as { ok: true; value: { faces: { centroid: Vec3; area: number }[] } };
    const body = r1.bodies.find((b) => b.id === `B${BOX}`);
    const i2 = body?.mesh.faceNames.indexOf(instName(2)) ?? -1;
    const at = fp.value.faces[i2] as { centroid: Vec3; area: number };
    const withFp = face(instName(2), { fingerprint: { centroid: at.centroid, area: at.area } });

    // More instances: instance 2 keeps its name.
    const r2 = await t.regen([...base, linear({ count: '5' }), thread(withFp)]);
    expect(stateOf(r2, THR)).toMatchObject({ state: 'ok' });
    expect(stateOf(r2, THR)?.rebound).toBeUndefined();
    // Skipping instance 1 never renumbers instance 2.
    const r3 = await t.regen([...base, linear({ skip: [1] }), thread(withFp)]);
    expect(stateOf(r3, THR)?.state).toBe('ok');
    // Count 2 with double spacing: instance 1 now sits exactly where instance 2 was. The ref is
    // unresolved, never silently moved to instance 1.
    const r4 = await t.regen([...base, linear({ count: '2', spacing: '50 mm' }), thread(withFp)]);
    expect(stateOf(r4, THR)).toMatchObject({
      state: 'needsAttention',
      unresolved: [{ path: '/face', reason: 'missing' }],
    });
    // Skipping instance 2 itself: missing as well.
    const r5 = await t.regen([...base, linear({ skip: [2] }), thread(withFp)]);
    expect(stateOf(r5, THR)?.state).toBe('needsAttention');
  });

  it('skips outside the pattern and a count of 1 are warnings; a fractional count is an error', async () => {
    const base = [box(), holeSketch(), hole()];
    const r = await t.regen([...base, linear({ skip: [0, 7] })]);
    expect(stateOf(r, PAT)?.state).toBe('ok');
    expect(stateOf(r, PAT)?.warnings?.[0]?.message).toMatch(/Skipped instances 0, 7/);
    const r1 = await t.regen([...base, linear({ count: '1' })]);
    expect(stateOf(r1, PAT)?.warnings?.[0]?.message).toMatch(/makes no copies/);
    const r2 = await t.regen([...base, linear({ count: '2.5' })]);
    expect(stateOf(r2, PAT)).toMatchObject({
      state: 'error',
      error: { message: 'Count must be a whole number of at least 1' },
    });
  });

  it('copying a failed feature is blocked; copying a fillet or a later feature is an error', async () => {
    t.kernel.failFor.add(HOLE);
    const r = await t.regen([box(), holeSketch(), hole(), linear()]);
    expect(stateOf(r, HOLE)?.state).toBe('error');
    expect(stateOf(r, PAT)?.state).toBe('blocked');
    t.kernel.failFor.clear();
    const fil: FilletFeature = {
      id: fid('FIL'),
      type: 'fillet',
      name: 'Fillet',
      suppressed: false,
      edges: [xEdge],
      radius: '1 mm',
    };
    const r2 = await t.regen([
      box(),
      fil,
      linear({ source: { kind: 'features', features: [fil.id] } }),
    ]);
    expect(stateOf(r2, PAT)?.error?.message).toMatch(/cannot be copied/);
    const r3 = await t.regen([box(), holeSketch(), linear(), hole()]);
    expect(stateOf(r3, PAT)?.error?.message).toMatch(/must come before this feature/);
    const r4 = await t.regen([
      box(),
      linear({ source: { kind: 'features', features: [fid('GONE')] } }),
    ]);
    expect(stateOf(r4, PAT)).toMatchObject({
      state: 'needsAttention',
      unresolved: [{ path: '/source/features/0', reason: 'missing' }],
    });
  });

  it('mirror of a boss: frames.plane, the new body as target, op add', async () => {
    const boss: BoxFeature = { ...box(fid('BOSS')), dx: '10 mm', dy: '10 mm', dz: '10 mm' };
    const m: MirrorFeature = {
      id: fid('MIR'),
      type: 'mirror',
      name: 'Mirror',
      suppressed: false,
      source: { kind: 'features', features: [boss.id] },
      plane: face('origin:YZ'),
    };
    const r = await t.regen([boss, m]);
    expect(stateOf(r, m.id)?.state).toBe('ok');
    const c = lastCall(t.kernel, m.id);
    expect(c?.inputs.values[`/ops/${boss.id}`]).toBe(0);
    close(must(must(c).inputs.frames?.plane).z, [1, 0, 0]);
    const b = r.bodies.find((x) => x.id === `B${boss.id}`);
    expect(b?.mesh.faceNames).toContain(`${tag(m.id)}:mirror(${tag(boss.id)}:face.xmax)`);
  });

  it('body copies: refs["/source/bodies/i"]; unmerged copies are new bodies', async () => {
    const m: MirrorFeature = {
      id: fid('MIR'),
      type: 'mirror',
      name: 'Mirror',
      suppressed: false,
      source: { kind: 'bodies', bodies: [{ name: `B${BOX}`, kind: 'body' }], merge: false },
      plane: face('origin:XZ'),
    };
    const r = await t.regen([box(), m]);
    expect(lastCall(t.kernel, m.id)?.inputs.refs?.['/source/bodies/0']).toMatchObject({
      kind: 'body',
      index: 0,
    });
    expect(r.bodies.map((b) => b.id).sort()).toEqual([`B${BOX}`, `B${m.id}`].sort());
    const merged = await t.regen([
      box(),
      { ...m, source: { ...m.source, merge: true } as MirrorFeature['source'] },
    ]);
    expect(merged.bodies.map((b) => b.id)).toEqual([`B${BOX}`]);
  });

  it('a circular pattern about an axis feature built from a box edge', async () => {
    const ax: AxisFeature = {
      id: fid('AX'),
      type: 'axis',
      name: 'Axis',
      suppressed: false,
      definition: { kind: 'edge', edge: edge(`${tag(BOX)}:edge(face.xmax|face.ymax)`) },
    };
    const cp: CircularPatternFeature = {
      id: fid('CP'),
      type: 'circularPattern',
      name: 'Ring',
      suppressed: false,
      source: { kind: 'features', features: [HOLE] },
      axis: edge(`${tag(ax.id)}:axis`),
      count: '6',
      angle: '360 deg',
      equalSpacing: true,
    };
    const r = await t.regen([box(), ax, holeSketch(), hole(), cp]);
    expect(stateOf(r, cp.id)?.state).toBe('ok');
    const fr = lastCall(t.kernel, cp.id)?.inputs.frames?.axis as Frame;
    close(fr.z, [0, 0, 1]);
    close(fr.origin, [100, 50, 0]);
    expect(lastCall(t.kernel, cp.id)?.inputs.values).toMatchObject({ '/count': 6 });
    expect(lastCall(t.kernel, cp.id)?.inputs.values['/angle']).toBeCloseTo(2 * Math.PI, 12);
  });
});

describe('M3 engine inputs: reference geometry', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('three-point planes (and flip) reach the kernel as frames; sketches use the frame', async () => {
    const pl: PlaneFeature = {
      id: fid('PL'),
      type: 'plane',
      name: 'Plane',
      suppressed: false,
      definition: {
        kind: 'threePoints',
        points: [
          { name: `${tag(BOX)}:vertex(min,min,max)`, kind: 'vertex' },
          { name: `${tag(BOX)}:vertex(max,min,max)`, kind: 'vertex' },
          { name: `${tag(BOX)}:vertex(min,max,max)`, kind: 'vertex' },
        ],
      },
    };
    const sk = new Sk();
    sk.point('q', 1, 2);
    const s = sk.feature(fid('SKP'), face(`${tag(pl.id)}:plane`));
    const r = await t.regen([box(), pl, s]);
    expect(stateOf(r, s.id)?.state).toBe('ok');
    const call = lastCall(t.kernel, pl.id);
    expect(call?.feature).toMatchObject({ definition: { kind: 'frame' } });
    expect('flip' in must(call).feature).toBe(false);
    const frame = r.sketches.find((x) => x.featureId === s.id)?.frame;
    close(frame?.z, [0, 0, 1]);
    close(frame?.origin, [0, 0, 20]);
    const r2 = await t.regen([box(), { ...pl, flip: true }, s]);
    close(r2.sketches.find((x) => x.featureId === s.id)?.frame.z, [0, 0, -1]);
    // Collinear points are an error with the refs.
    const bad: PlaneFeature = {
      ...pl,
      definition: {
        kind: 'threePoints',
        points: [
          { name: `${tag(BOX)}:vertex(min,min,min)`, kind: 'vertex' },
          { name: `${tag(BOX)}:vertex(max,min,min)`, kind: 'vertex' },
          { name: 'origin:O', kind: 'vertex' },
        ],
      },
    };
    const r3 = await t.regen([box(), bad]);
    expect(stateOf(r3, pl.id)?.error?.message).toBe('The three points lie on one line');
  });

  it('midplane, through-point, angle and offset+flip planes', async () => {
    const mk = (definition: PlaneFeature['definition'], flip?: boolean): PlaneFeature => ({
      id: fid('PL'),
      type: 'plane',
      name: 'Plane',
      suppressed: false,
      definition,
      ...(flip === undefined ? {} : { flip }),
    });
    const sk = new Sk();
    sk.point('q', 0, 0);
    const s = sk.feature(fid('SKP'), face(`${tag(fid('PL'))}:plane`));
    const frameFor = async (pl: PlaneFeature) => {
      const r = await t.regen([box(), pl, s]);
      expect(stateOf(r, pl.id)?.state, JSON.stringify(stateOf(r, pl.id))).toBe('ok');
      return r.sketches.find((x) => x.featureId === s.id)?.frame;
    };
    const mid = await frameFor(
      mk({ kind: 'midplane', a: face(`${tag(BOX)}:face.xmin`), b: face(`${tag(BOX)}:face.xmax`) }),
    );
    close(mid?.origin, [50, 0, 0]);
    const through = await frameFor(
      mk({
        kind: 'throughPoint',
        from: face('origin:XY'),
        point: { name: `${tag(BOX)}:vertex(max,max,max)`, kind: 'vertex' },
      }),
    );
    close(through?.origin, [0, 0, 20]);
    const angled = await frameFor(
      mk({ kind: 'angle', from: face('origin:XY'), axis: edge('origin:X'), angle: '90 deg' }),
    );
    close(angled?.z, [0, -1, 0]);
    const off = await frameFor(
      mk({ kind: 'offset', from: face('origin:XY'), distance: '5 mm' }, true),
    );
    close(off?.z, [0, 0, -1]);
    close(off?.origin, [0, 0, 5]);
    const normal = await frameFor(mk({ kind: 'normalToCurve', curve: xEdge, at: { t: '0.25' } }));
    close(normal?.z, [1, 0, 0]);
    close(normal?.origin, [25, 0, 0]);
  });

  it('axes from two planes and points along edges / intersections', async () => {
    const ax: AxisFeature = {
      id: fid('AX'),
      type: 'axis',
      name: 'Axis',
      suppressed: false,
      definition: { kind: 'twoPlanes', a: face('origin:XZ'), b: face(`${tag(BOX)}:face.xmax`) },
    };
    const along: PointFeature = {
      id: fid('PA'),
      type: 'point',
      name: 'Point',
      suppressed: false,
      definition: { kind: 'alongEdge', edge: xEdge, t: '0.5' },
    };
    const meet: PointFeature = {
      id: fid('PB'),
      type: 'point',
      name: 'Point',
      suppressed: false,
      definition: { kind: 'intersection', a: edge(`${tag(ax.id)}:axis`), b: face('origin:XY') },
    };
    // Each point is used by a hole on the bottom face so its location is observable.
    const h = (id: Id, p: Id): HoleFeature => ({
      ...hole(),
      id,
      face: face(`${tag(BOX)}:face.zmin`),
      points: [{ name: `${tag(p)}:point`, kind: 'vertex' }],
    });
    const r = await t.regen([
      box(),
      ax,
      along,
      meet,
      h(fid('H1'), along.id),
      h(fid('H2'), meet.id),
    ]);
    expect(r.features.map((f) => f.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    close(must(must(lastCall(t.kernel, fid('H1'))).inputs.frames?.['hole:0']).origin, [50, 0, 0]);
    close(must(must(lastCall(t.kernel, fid('H2'))).inputs.frames?.['hole:0']).origin, [100, 0, 0]);
    close(must(must(lastCall(t.kernel, fid('H2'))).inputs.frames?.['hole:0']).z, [0, 0, 1]);
  });
});

describe('M3 engine inputs: shell, sweep, propagate', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('shell: target, refs["/openFaces/i"], thickness; shelled faces are named', async () => {
    const sh: ShellFeature = {
      id: fid('SH'),
      type: 'shell',
      name: 'Shell',
      suppressed: false,
      openFaces: [top],
      thickness: '2 mm',
      direction: 'inward',
    };
    const r = await t.regen([box(), sh]);
    const c = lastCall(t.kernel, sh.id);
    expect(c?.inputs.refs?.['/openFaces/0']).toMatchObject({ kind: 'face', index: 5 });
    expect(c?.inputs.values['/thickness']).toBe(2);
    expect(r.bodies[0]?.mesh.faceNames).toContain(`${tag(sh.id)}:shell(${tag(BOX)}:face.zmin)`);
    const bad = await t.regen([box(), { ...sh, thickness: '0 mm' }]);
    expect(stateOf(bad, sh.id)?.error?.message).toBe(
      'The shell thickness must be greater than zero',
    );
  });

  it('sweep: the path refs reach the kernel chained in order', async () => {
    const s = new Sk();
    s.point('a', 0, 0);
    s.point('b', 10, 0);
    s.point('c', 10, 10);
    s.point('d', 20, 10);
    s.line('l1', 'a', 'b');
    s.line('l2', 'b', 'c');
    s.line('l3', 'c', 'd');
    const path = s.feature(fid('SKPATH'), 'origin:XZ');
    const prof = new Sk();
    prof.rect('r', 'e', -1, -1, 1, 1);
    const profile = prof.feature(fid('SKPROF'), 'origin:YZ');
    const sw: SweepFeature = {
      id: fid('SW'),
      type: 'sweep',
      name: 'Sweep',
      suppressed: false,
      profile: [{ name: `S${profile.id}:region(e1,e2,e3,e4)`, kind: 'region' }],
      // Scrambled: the middle edge first.
      path: ['l2', 'l3', 'l1'].map((l) => edge(`S${path.id}:e(${l})`)),
      orientation: 'followPath',
      op: 'new',
    };
    const r = await t.regen([path, profile, sw]);
    expect(stateOf(r, sw.id)?.state, JSON.stringify(stateOf(r, sw.id))).toBe('ok');
    const c = lastCall(t.kernel, sw.id);
    expect((must(c).feature as SweepFeature).path.map((p) => p.name)).toEqual(
      ['l1', 'l2', 'l3'].map((l) => `S${path.id}:e(${l})`),
    );
    expect(c?.inputs.refs?.['/path/0']).toBeDefined();
    expect(c?.inputs.refs?.['/profile/0']).toBeDefined();
    // A branch is refused.
    s.point('e', 10, -10);
    s.line('l4', 'b', 'e');
    const branched = s.feature(fid('SKPATH'), 'origin:XZ');
    const r2 = await t.regen([
      branched,
      profile,
      { ...sw, path: [...sw.path, edge(`S${path.id}:e(l4)`)] },
    ]);
    expect(stateOf(r2, sw.id)?.error?.message).toBe(
      'The sweep path branches; select one chain of edges',
    );
  });

  it('fillet propagate passes through and absent = true shares the cache entry', async () => {
    const fil: FilletFeature = {
      id: fid('FIL'),
      type: 'fillet',
      name: 'Fillet',
      suppressed: false,
      edges: [xEdge],
      radius: '1 mm',
    };
    await t.regen([box(), { ...fil, propagate: false }]);
    expect((must(lastCall(t.kernel, fil.id)).feature as FilletFeature).propagate).toBe(false);
    await t.regen([box(), fil]);
    const n = t.kernel.callsFor(fil.id).length;
    const r = await t.regen([box(), { ...fil, propagate: true }]);
    expect(stateOf(r, fil.id)?.cached).toBe(true);
    expect(t.kernel.callsFor(fil.id).length).toBe(n);
  });
});

describe('M3 linked sketch entities (Convert Entities)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  /** A sketch on XY with a line linked to the box's top front edge (y = 0, z = 20). */
  function linkedSketch(source: EntityRef): SketchFeature {
    const s = new Sk();
    s.point('a', 1, 1);
    s.point('b', 50, 3);
    s.line('l', 'a', 'b');
    const f = s.feature(fid('SKL'), 'origin:XY');
    f.entities = f.entities.map((e) => (e.id === 'l' ? { ...e, source: { ref: source } } : e));
    return f;
  }
  const topFront = edge(`${tag(BOX)}:edge(face.ymin|face.zmax)`);

  it('re-projects a linked line onto its source before solving and fixes it', async () => {
    const r = await t.regen([box(), linkedSketch(topFront)]);
    expect(stateOf(r, fid('SKL'))?.state).toBe('ok');
    const sk = lastCall(t.kernel, fid('SKL'))?.feature as SketchFeature;
    expectPoint(sk, 'a', 0, 0);
    expectPoint(sk, 'b', 100, 0);
    const solved = r.sketches.find((s) => s.featureId === fid('SKL'));
    // Displayed where the source is (world space).
    const b = solved?.points?.find((p) => p.entity === 'b')?.at;
    close(b, [100, 0, 0]);
    // The linked line and its points are grounded for the solver.
    const input = t.solves.at(-1);
    expect(
      input?.constraints
        .filter((c) => c.kind === 'fix')
        .map((c) => c.id)
        .sort(),
    ).toEqual(['@linked:a', '@linked:b', '@linked:l']);
  });

  it('upstream edits move the linked entity; unchanged sources keep the sketch cached', async () => {
    await t.regen([box(), linkedSketch(topFront)]);
    const again = await t.regen([box(), linkedSketch(topFront)]);
    expect(stateOf(again, fid('SKL'))?.cached).toBe(true);
    const longer: BoxFeature = { ...box(), dx: '120 mm' };
    const r = await t.regen([longer, linkedSketch(topFront)]);
    expect(stateOf(r, fid('SKL'))?.cached).toBe(false);
    const sk = lastCall(t.kernel, fid('SKL'))?.feature as SketchFeature;
    expectPoint(sk, 'b', 120, 0);
  });

  it('a lost source needs attention with the entity id; nothing is re-picked', async () => {
    const r = await t.regen([{ ...box(), suppressed: true }, linkedSketch(topFront)]);
    const st = stateOf(r, fid('SKL'));
    expect(st).toMatchObject({
      state: 'needsAttention',
      unresolved: [{ path: '/entities/2/source/ref', reason: 'missing' }],
    });
    expect(st?.error?.entityRefs).toContain(`S${fid('SKL')}:e(l)`);
    expect(st?.error?.message).toBe('A linked sketch entity has lost its source');
    expect(r.sketches.find((s) => s.featureId === fid('SKL'))).toBeUndefined();
  });

  it('an entity that no longer fits its source (point → line) is lost too', async () => {
    const s = new Sk();
    s.point('a', 1, 1);
    const f = s.feature(fid('SKL'), 'origin:XY');
    f.entities = [
      { ...(f.entities[0] as SketchFeature['entities'][number]), source: { ref: topFront } },
    ];
    const r = await t.regen([box(), f]);
    expect(stateOf(r, fid('SKL'))).toMatchObject({
      state: 'needsAttention',
      unresolved: [{ path: '/entities/0/source/ref' }],
    });
  });

  it('origin axes and planes project to lines; the kernel projection is used when present', async () => {
    const s = new Sk();
    s.point('a', 3, 4);
    s.point('b', 8, 9);
    s.line('l', 'a', 'b');
    const f = s.feature(fid('SKL'), 'origin:XY');
    f.entities = f.entities.map((e) =>
      e.id === 'l' ? { ...e, source: { ref: face('origin:XZ') } } : e,
    );
    await t.regen([box(), f]);
    const sk = lastCall(t.kernel, fid('SKL'))?.feature as SketchFeature;
    // The XZ plane's trace on XY is the X axis: the line keeps its x extent, y = 0.
    expectPoint(sk, 'a', 3, 0);
    expectPoint(sk, 'b', 8, 0);

    const k2 = new FakeKernel();
    const seen: unknown[] = [];
    k2.projection = {
      projectEdges: async (shape, edges, plane) => {
        seen.push({ shape, edges, plane });
        return {
          ok: true,
          value: [{ edge: edges[0] as number, curves: [{ kind: 'line', a: [5, 5], b: [6, 6] }] }],
        };
      },
      projectFaceOutline: async () => ({ ok: true, value: [] }),
    };
    const e2 = new RegenEngine({ kernel: k2.api(), sketchSolver: async () => identitySolver });
    const r2 = await e2.regenerate({
      doc: makeDoc({}, [box(), linkedSketch(topFront)], PART),
      partId: PART,
      quality: 'coarse',
    });
    expect(stateOf(r2, fid('SKL'))?.state).toBe('ok');
    expect(seen).toHaveLength(1);
    const sk2 = k2.callsFor(fid('SKL')).at(-1)?.feature as SketchFeature;
    expectPoint(sk2, 'a', 5, 5);
  });
});

/** Keeps `WrenDoc` imported for editors that inline types. */
export type _Doc = WrenDoc;
