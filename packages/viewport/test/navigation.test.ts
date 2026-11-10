import type { NavigationPreset, Vec3 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  countIdPixels,
  mapMouseButton,
  NavigationMachine,
  type NavOutput,
  type NavSample,
  normalizeRect,
  orbitTrackball,
  orbitTurntable,
  type PivotInput,
  type Pose,
  polylineVsRect,
  resolvePivot,
  segmentTouchesRect,
  triangleTouchesRect,
} from '../src/navigation';

const mouse = (
  type: NavSample['type'],
  button: number,
  x: number,
  y: number,
  t: number,
  mods: Partial<NavSample['mods']> = {},
): NavSample => ({
  type,
  id: 1,
  pointerType: 'mouse',
  button,
  x,
  y,
  t,
  mods: { ctrl: false, shift: false, alt: false, meta: false, ...mods },
});

const run = (m: NavigationMachine, samples: NavSample[]): NavOutput[] =>
  samples.flatMap((s) => m.handle(s));

describe('mapMouseButton', () => {
  const presets: NavigationPreset[] = [
    'rightOrbit',
    'middleOrbit',
    'middlePan',
    'rightOrbitRepeat',
  ];
  it('never navigates with the left button, under any preset', () => {
    for (const p of presets) {
      for (const mods of [{}, { ctrl: true }, { shift: true }, { alt: true }]) {
        expect(
          mapMouseButton(p, 0, { ctrl: false, shift: false, alt: false, meta: false, ...mods }),
        ).toEqual({
          drag: null,
          click: null,
        });
      }
    }
  });
  it('rightOrbit: right orbits, middle pans', () => {
    expect(mapMouseButton('rightOrbit', 2)).toEqual({ drag: 'orbit', click: 'menu' });
    expect(mapMouseButton('rightOrbit', 1)).toEqual({ drag: 'pan', click: null });
  });
  it('rightOrbitRepeat: right click repeats or opens the menu', () => {
    expect(mapMouseButton('rightOrbitRepeat', 2)).toEqual({ drag: 'orbit', click: 'menuRepeat' });
    expect(mapMouseButton('rightOrbitRepeat', 1).drag).toBe('pan');
  });
  it('middleOrbit: middle orbits, ctrl+middle pans, middle click sets the pivot', () => {
    expect(mapMouseButton('middleOrbit', 1)).toEqual({ drag: 'orbit', click: 'setPivot' });
    expect(
      mapMouseButton('middleOrbit', 1, { ctrl: true, shift: false, alt: false, meta: false }),
    ).toEqual({
      drag: 'pan',
      click: null,
    });
    expect(mapMouseButton('middleOrbit', 2).click).toBe('menu');
  });
  it('middlePan: middle pans, shift+middle orbits', () => {
    expect(mapMouseButton('middlePan', 1).drag).toBe('pan');
    expect(
      mapMouseButton('middlePan', 1, { ctrl: false, shift: true, alt: false, meta: false }).drag,
    ).toBe('orbit');
    expect(mapMouseButton('middlePan', 2).click).toBe('menu');
  });
});

describe('NavigationMachine', () => {
  it('ignores the left button entirely', () => {
    const m = new NavigationMachine();
    const out = run(m, [
      mouse('down', 0, 10, 10, 0),
      mouse('move', 0, 80, 40, 50),
      mouse('up', 0, 80, 40, 100),
    ]);
    expect(out).toEqual([]);
    expect(m.tracking()).toBe(false);
  });

  it('a right click within the threshold emits contextMenu, not a drag', () => {
    const m = new NavigationMachine();
    const out = run(m, [
      mouse('down', 2, 100, 100, 0),
      mouse('move', 2, 102, 101, 20),
      mouse('up', 2, 102, 101, 60),
    ]);
    expect(out).toEqual([{ type: 'click', kind: 'contextMenu', x: 102, y: 101, repeat: false }]);
  });

  it('a right drag past the threshold orbits from the press point and emits no menu', () => {
    const m = new NavigationMachine();
    const out = run(m, [
      mouse('down', 2, 100, 100, 0),
      mouse('move', 2, 110, 100, 20),
      mouse('move', 2, 120, 100, 40),
      mouse('up', 2, 120, 100, 60),
    ]);
    expect(out[0]).toEqual({ type: 'begin', mode: 'orbit', x: 100, y: 100, pointerType: 'mouse' });
    // The first drag carries everything since the press, so the motion stays 1:1.
    expect(out[1]).toEqual({ type: 'drag', mode: 'orbit', dx: 10, dy: 0 });
    expect(out[2]).toEqual({ type: 'drag', mode: 'orbit', dx: 10, dy: 0 });
    expect(out[3]).toEqual({ type: 'end', mode: 'orbit' });
    expect(out.some((o) => o.type === 'click')).toBe(false);
  });

  it('a press that crossed the threshold and came back is still a drag, not a click', () => {
    const m = new NavigationMachine();
    const out = run(m, [
      mouse('down', 2, 100, 100, 0),
      mouse('move', 2, 120, 100, 20),
      mouse('move', 2, 100, 100, 40),
      mouse('up', 2, 100, 100, 60),
    ]);
    expect(out.some((o) => o.type === 'click')).toBe(false);
  });

  it('rightOrbitRepeat: quick click repeats, hold opens the menu', () => {
    const m = new NavigationMachine();
    m.setPreset('rightOrbitRepeat');
    const quick = run(m, [mouse('down', 2, 5, 5, 0), mouse('up', 2, 5, 5, 120)]);
    expect(quick).toEqual([{ type: 'click', kind: 'contextMenu', x: 5, y: 5, repeat: true }]);
    const hold = run(m, [mouse('down', 2, 5, 5, 1000), mouse('up', 2, 5, 5, 1400)]);
    expect(hold).toEqual([{ type: 'click', kind: 'contextMenu', x: 5, y: 5, repeat: false }]);
    // Between "quick" and "hold" the press still opens the menu rather than doing nothing.
    const mid = run(m, [mouse('down', 2, 5, 5, 2000), mouse('up', 2, 5, 5, 2300)]);
    expect(mid[0]).toMatchObject({ kind: 'contextMenu', repeat: false });
  });

  it('rightOrbitRepeat: a drag still orbits and does not repeat', () => {
    const m = new NavigationMachine();
    m.setPreset('rightOrbitRepeat');
    const out = run(m, [
      mouse('down', 2, 5, 5, 0),
      mouse('move', 2, 40, 5, 30),
      mouse('up', 2, 40, 5, 60),
    ]);
    expect(out.map((o) => o.type)).toEqual(['begin', 'drag', 'end']);
  });

  it('middleOrbit: middle click asks the host to set the pivot, middle drag orbits', () => {
    const m = new NavigationMachine();
    m.setPreset('middleOrbit');
    expect(run(m, [mouse('down', 1, 9, 9, 0), mouse('up', 1, 9, 9, 50)])).toEqual([
      { type: 'click', kind: 'setPivot', x: 9, y: 9, repeat: false },
    ]);
    const drag = run(m, [
      mouse('down', 1, 9, 9, 100),
      mouse('move', 1, 60, 9, 120),
      mouse('up', 1, 60, 9, 140),
    ]);
    expect(drag[0]).toMatchObject({ type: 'begin', mode: 'orbit' });
  });

  it('middleOrbit with ctrl pans; the right button opens the menu on click and pans on drag', () => {
    const m = new NavigationMachine();
    m.setPreset('middleOrbit');
    const pan = run(m, [
      mouse('down', 1, 0, 0, 0, { ctrl: true }),
      mouse('move', 1, 30, 0, 10, { ctrl: true }),
      mouse('up', 1, 30, 0, 20, { ctrl: true }),
    ]);
    expect(pan[0]).toMatchObject({ type: 'begin', mode: 'pan' });
    expect(run(m, [mouse('down', 2, 0, 0, 100), mouse('up', 2, 0, 0, 130)])[0]).toMatchObject({
      kind: 'contextMenu',
    });
    const rdrag = run(m, [
      mouse('down', 2, 0, 0, 200),
      mouse('move', 2, 40, 0, 210),
      mouse('up', 2, 40, 0, 220),
    ]);
    expect(rdrag[0]).toMatchObject({ type: 'begin', mode: 'pan' });
  });

  it('middlePan: middle pans, shift+middle orbits', () => {
    const m = new NavigationMachine();
    m.setPreset('middlePan');
    expect(run(m, [mouse('down', 1, 0, 0, 0), mouse('move', 1, 30, 0, 10)])[0]).toMatchObject({
      mode: 'pan',
    });
    m.handle(mouse('up', 1, 30, 0, 20));
    expect(
      run(m, [
        mouse('down', 1, 0, 0, 100, { shift: true }),
        mouse('move', 1, 30, 0, 110, { shift: true }),
      ])[0],
    ).toMatchObject({ mode: 'orbit' });
  });

  it('a second mouse button during a drag does not restart or end it', () => {
    const m = new NavigationMachine();
    run(m, [mouse('down', 2, 0, 0, 0), mouse('move', 2, 30, 0, 10)]);
    expect(m.activeMode()).toBe('orbit');
    m.handle({ ...mouse('down', 1, 30, 0, 20) });
    expect(m.handle({ ...mouse('up', 1, 30, 0, 30) })).toEqual([]);
    expect(m.activeMode()).toBe('orbit');
    expect(m.handle(mouse('up', 2, 30, 0, 40))).toEqual([{ type: 'end', mode: 'orbit' }]);
  });

  it('one-finger touch orbits after the tap slop; a second finger ends the orbit', () => {
    const m = new NavigationMachine();
    const touch = (
      type: NavSample['type'],
      id: number,
      x: number,
      y: number,
      t: number,
    ): NavSample => ({
      type,
      id,
      pointerType: 'touch',
      button: 0,
      x,
      y,
      t,
    });
    expect(run(m, [touch('down', 1, 50, 50, 0), touch('move', 1, 54, 50, 10)])).toEqual([]);
    const out = run(m, [touch('move', 1, 70, 50, 20)]);
    expect(out[0]).toMatchObject({
      type: 'begin',
      mode: 'orbit',
      pointerType: 'touch',
      x: 50,
      y: 50,
    });
    expect(m.handle(touch('down', 2, 200, 50, 30))).toEqual([{ type: 'end', mode: 'orbit' }]);
    // The remaining finger never resumes an orbit mid-pinch.
    expect(run(m, [touch('up', 2, 200, 50, 40), touch('move', 1, 120, 50, 50)])).toEqual([]);
    m.handle(touch('up', 1, 120, 50, 60));
    // All fingers up: a new touch navigates again.
    expect(run(m, [touch('down', 3, 0, 0, 100), touch('move', 3, 40, 0, 110)])[0]).toMatchObject({
      type: 'begin',
    });
  });

  it('abort ends a drag in progress', () => {
    const m = new NavigationMachine();
    run(m, [mouse('down', 2, 0, 0, 0), mouse('move', 2, 30, 0, 10)]);
    expect(m.abort()).toEqual([{ type: 'end', mode: 'orbit' }]);
    expect(m.tracking()).toBe(false);
  });
});

describe('resolvePivot', () => {
  // Camera at the origin looking down +Y; "screen" is x in [-10, 10], z in [-10, 10] at any depth.
  const project = (p: Vec3) => ({ nx: p[0] / 10, ny: p[2] / 10, depth: p[1] });
  const base = (over: Partial<PivotInput> = {}): PivotInput => ({
    mode: 'cursor',
    hit: null,
    override: null,
    center: [0, 50, 0],
    centerHit: () => null,
    project,
    cameraPosition: [0, 0, 0],
    forward: [0, 1, 0],
    fallbackDistance: 80,
    ...over,
  });

  it('uses the surface point under the cursor', () => {
    expect(resolvePivot(base({ hit: [3, 40, 1] }))).toEqual({
      point: [3, 40, 1],
      source: 'surface',
    });
  });
  it('on a miss uses the visible bodies centre', () => {
    expect(resolvePivot(base())).toEqual({ point: [0, 50, 0], source: 'center' });
  });
  it('never uses a stale override that left the screen', () => {
    expect(resolvePivot(base({ override: [500, 50, 0] })).source).toBe('center');
    expect(resolvePivot(base({ override: [1, 50, 1] })).source).toBe('override');
  });
  it('an off-screen centre falls back to the surface at the viewport centre', () => {
    const r = resolvePivot(base({ center: [500, 50, 0], centerHit: () => [0, 30, 0] }));
    expect(r).toEqual({ point: [0, 30, 0], source: 'screenCenter' });
  });
  it('with nothing usable the pivot is on the view axis at the centre depth, never off screen', () => {
    const r = resolvePivot(base({ center: [500, 50, 0] }));
    expect(r.source).toBe('axis');
    expect(r.point).toEqual([0, 50, 0]);
    expect(Math.abs(project(r.point).nx)).toBeLessThanOrEqual(1);
  });
  it('a centre behind the camera is never used', () => {
    const r = resolvePivot(base({ center: [0, -20, 0] }));
    expect(r.source).toBe('axis');
    expect(r.point[1]).toBe(80); // fallback distance, in front of the camera
    const c = resolvePivot(base({ mode: 'center', center: [0, -20, 0] }));
    expect(c.point[1]).toBeGreaterThan(0);
  });
  it('an empty scene uses the orbit distance on the view axis', () => {
    expect(resolvePivot(base({ center: null }))).toEqual({ point: [0, 80, 0], source: 'axis' });
  });
  it("'center' mode ignores the cursor hit", () => {
    const r = resolvePivot(base({ mode: 'center', hit: [3, 40, 1], center: [0, 60, 2] }));
    expect(r).toEqual({ point: [0, 60, 2], source: 'center' });
  });
  it("'center' mode may use an off-screen centre (always the bodies' centre)", () => {
    expect(resolvePivot(base({ mode: 'center', center: [500, 50, 0] })).source).toBe('center');
  });
  it('rejects non-finite points', () => {
    expect(resolvePivot(base({ hit: [Number.NaN, 1, 1] })).source).toBe('center');
  });
});

describe('orbit rotation', () => {
  const pose: Pose = { pos: [0, -100, 0], fwd: [0, 1, 0], up: [0, 0, 1] };
  const Z: Vec3 = [0, 0, 1];
  const K = (2 * Math.PI) / 800;

  /** Camera-space position of `p`: (right, up, forward) components. */
  const camSpace = (pp: Pose, p: Vec3) => {
    const d = [p[0] - pp.pos[0], p[1] - pp.pos[1], p[2] - pp.pos[2]];
    const r = [
      pp.fwd[1] * pp.up[2] - pp.fwd[2] * pp.up[1],
      pp.fwd[2] * pp.up[0] - pp.fwd[0] * pp.up[2],
      pp.fwd[0] * pp.up[1] - pp.fwd[1] * pp.up[0],
    ];
    const dot = (a: number[], b: ArrayLike<number>) =>
      a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    return [dot(d, r), dot(d, pp.up), dot(d, pp.fwd)];
  };

  it('keeps the pivot at the same camera-space position (same screen point)', () => {
    const pivot: Vec3 = [10, 5, 20];
    const before = camSpace(pose, pivot);
    for (const next of [
      orbitTurntable(pose, pivot, Z, 120, -60, K),
      orbitTrackball(pose, pivot, 120, -60, K),
    ]) {
      const after = camSpace(next, pivot);
      for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(before[i]!, 6);
    }
  });

  it('turntable keeps +Z vertical on screen however far it is dragged', () => {
    let p = pose;
    for (let i = 0; i < 200; i++) p = orbitTurntable(p, [0, 0, 0], Z, 13, -7, K);
    // Camera right is horizontal (no roll): its z component is zero.
    const right = p.fwd[0] * p.up[1] - p.fwd[1] * p.up[0];
    expect(right).toBeDefined();
    const rz = p.fwd[0] * p.up[1] - p.fwd[1] * p.up[0];
    expect(Math.abs(rz)).toBeGreaterThan(0); // sanity: not degenerate
    const rightVec = [
      p.fwd[1] * p.up[2] - p.fwd[2] * p.up[1],
      p.fwd[2] * p.up[0] - p.fwd[0] * p.up[2],
      p.fwd[0] * p.up[1] - p.fwd[1] * p.up[0],
    ];
    expect(rightVec[2]).toBeCloseTo(0, 6);
    expect(p.up[2]).toBeGreaterThan(0);
  });

  it('turntable stops at the poles, trackball goes over them', () => {
    let turn = pose;
    let ball = pose;
    for (let i = 0; i < 400; i++) {
      turn = orbitTurntable(turn, [0, 0, 0], Z, 0, 5, K); // drag down: look from above
      ball = orbitTrackball(ball, [0, 0, 0], 0, 5, K);
    }
    // The turntable camera never crosses the pole: view elevation stays within +-90 deg.
    expect(Math.abs(turn.fwd[2])).toBeLessThan(1);
    expect(turn.up[2]).toBeGreaterThan(0);
    // The trackball has gone around: up has flipped below the horizon at some point.
    let flipped = false;
    let b = pose;
    for (let i = 0; i < 400; i++) {
      b = orbitTrackball(b, [0, 0, 0], 0, 5, K);
      if (b.up[2] < -0.5) flipped = true;
    }
    expect(flipped).toBe(true);
    expect(Math.hypot(...ball.fwd)).toBeCloseTo(1, 6);
  });

  it('drag right turns the model to the right; drag down looks from above', () => {
    const right = orbitTurntable(pose, [0, 0, 0], Z, 100, 0, K);
    expect(right.pos[0]).toBeLessThan(0); // camera moved left
    const down = orbitTurntable(pose, [0, 0, 0], Z, 0, 100, K);
    expect(down.pos[2]).toBeGreaterThan(0); // camera moved up
    const tbRight = orbitTrackball(pose, [0, 0, 0], 100, 0, K);
    expect(tbRight.pos[0]).toBeLessThan(0);
  });

  it('rotation gain is linear in k', () => {
    const a = orbitTurntable(pose, [0, 0, 0], Z, 40, 0, K);
    const b = orbitTurntable(pose, [0, 0, 0], Z, 40, 0, 2 * K);
    expect(Math.atan2(b.pos[0], -b.pos[1])).toBeCloseTo(2 * Math.atan2(a.pos[0], -a.pos[1]), 6);
  });

  it('turntable does not yank a camera already at the pole', () => {
    const top: Pose = { pos: [0, 0, 100], fwd: [0, 0, -1], up: [0, 1, 0] };
    const next = orbitTurntable(top, [0, 0, 0], Z, 0, 0.0001, K);
    expect(next.pos[2]).toBeGreaterThan(99);
  });
});

describe('rect tests', () => {
  const r = normalizeRect({ x0: 100, y0: 80, x1: 20, y1: 10 });
  it('normalises corner order', () => {
    expect(r).toEqual({ x0: 20, y0: 10, x1: 100, y1: 80 });
  });
  it('segment vs rect', () => {
    expect(segmentTouchesRect(0, 40, 200, 40, r)).toBe(true); // through
    expect(segmentTouchesRect(0, 0, 10, 100, r)).toBe(false); // beside
    expect(segmentTouchesRect(30, 20, 40, 30, r)).toBe(true); // inside
    expect(segmentTouchesRect(100, 0, 100, 200, r)).toBe(true); // along the edge
  });
  it('triangle vs rect, including a rect wholly inside the triangle', () => {
    expect(triangleTouchesRect(0, 0, 400, 0, 0, 400, r)).toBe(true);
    expect(triangleTouchesRect(200, 200, 300, 200, 200, 300, r)).toBe(false);
    expect(triangleTouchesRect(90, 70, 150, 70, 90, 150, r)).toBe(true);
  });
  it('polyline window needs every point inside, crossing any touch', () => {
    const inside = [30, 20, 60, 50, 90, 70];
    expect(polylineVsRect(inside, 3, r)).toEqual({ inside: true, touches: true });
    const poke = [30, 20, 300, 20];
    expect(polylineVsRect(poke, 2, r)).toEqual({ inside: false, touches: true });
    const across = [0, 40, 200, 40]; // no point inside, the segment crosses
    expect(polylineVsRect(across, 2, r)).toEqual({ inside: false, touches: true });
    expect(polylineVsRect([0, 0, 5, 5], 2, r)).toEqual({ inside: false, touches: false });
    const behind = [30, 20, Number.NaN, Number.NaN];
    expect(polylineVsRect(behind, 2, r).inside).toBe(false);
  });
});

describe('countIdPixels', () => {
  // 4x2 image, ids: row0 = 1 1 2 0, row1 = 1 2 2 3 (top-down)
  const ids = [1, 1, 2, 0, 1, 2, 2, 3];
  const make = (flip: boolean) => {
    const data = new Uint8Array(8 * 4);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        const row = flip ? 1 - y : y;
        data[(row * 4 + x) * 4 + 2] = ids[y * 4 + x] as number;
      }
    }
    return data;
  };
  it('counts per id inside a box, for both readback orders', () => {
    for (const flip of [false, true]) {
      const counts = new Uint32Array(4);
      const fx = new Int32Array(4).fill(-1);
      const fy = new Int32Array(4).fill(-1);
      countIdPixels(make(flip), 4, 2, flip, 1, 0, 2, 1, counts, fx, fy);
      expect([...counts]).toEqual([0, 1, 3, 0]);
      expect([fx[2], fy[2]]).toEqual([2, 0]);
      const all = new Uint32Array(4);
      countIdPixels(make(flip), 4, 2, flip, 0, 0, 3, 1, all);
      expect([...all]).toEqual([0, 3, 3, 1]);
    }
  });
});
