/**
 * Synthetic hand-drawn strokes for recognition tests: a seeded PRNG, an ideal path per shape and
 * a pen model (ease-in/out and slowing at corners at 240 Hz, low-frequency wobble across the
 * path, per-sample jitter, overshoot past corners, closing gaps/overlaps). Deterministic per
 * seed, so the corpus is generated in the test rather than committed as JSON.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { StrokeSample, Vec2 } from '@wren-cad/contracts';

export type Rng = () => number;

/** mulberry32: small, fast, good enough for test corpora. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const range = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();
const gauss = (rng: Rng): number => {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};
const DEG = Math.PI / 180;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Distance from p to segment ab. */
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const l2 = d[0] * d[0] + d[1] * d[1];
  const t =
    l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2)) : 0;
  return dist(p, [a[0] + d[0] * t, a[1] + d[1] * t]);
}

export interface Pen {
  /** Per-sample jitter σ, mm. */
  jitter: number;
  /** Low-frequency wobble amplitude across the path, mm. */
  wobble: number;
  /** Cruise speed, mm/s. */
  speed: number;
  /** Sample interval, s (Apple Pencil ≈ 240 Hz). */
  dt: number;
}

export const HAND: Pen = { jitter: 0.12, wobble: 0.45, speed: 220, dt: 1 / 240 };
/** A shakier, faster hand (2× jitter and wobble, 1.5× speed). */
export const SHAKY: Pen = { jitter: 0.25, wobble: 0.9, speed: 330, dt: 1 / 240 };

let currentPen: Pen = HAND;
/** Runs `fn` with every generator using `pen`. */
export function withPen<T>(pen: Pen, fn: () => T): T {
  const prev = currentPen;
  currentPen = pen;
  try {
    return fn();
  } finally {
    currentPen = prev;
  }
}

/**
 * Samples a pen following `path` (a polyline; `corners` are vertex indices where the hand
 * slows down). Speed eases in/out at the ends and drops to ~25% at corners; speed also varies
 * randomly by ±30%.
 */
export function penStroke(
  path: readonly Vec2[],
  corners: readonly number[],
  rng: Rng,
  pen: Pen = currentPen,
): StrokeSample[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Vec2;
    const b = path[i] as Vec2;
    cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[cum.length - 1] as number;
  const cornerS = corners.map((i) => cum[i] as number);
  const ph = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
  const lam = [range(rng, 35, 70), range(rng, 12, 25)];
  const out: StrokeSample[] = [];
  let s = 0;
  let t = 0;
  let k = 0;
  while (true) {
    while (k + 1 < path.length - 1 && (cum[k + 1] as number) < s) k++;
    const a = path[k] as Vec2;
    const b = path[k + 1] as Vec2;
    const sl = (cum[k + 1] as number) - (cum[k] as number);
    const f = sl > 0 ? Math.min(1, Math.max(0, (s - (cum[k] as number)) / sl)) : 0;
    const dx = sl > 0 ? (b[0] - a[0]) / sl : 0;
    const dy = sl > 0 ? (b[1] - a[1]) / sl : 0;
    const w =
      pen.wobble *
      (0.65 * Math.sin((2 * Math.PI * s) / (lam[0] as number) + (ph[0] as number)) +
        0.35 * Math.sin((2 * Math.PI * s) / (lam[1] as number) + (ph[1] as number)));
    out.push({
      x: a[0] + (b[0] - a[0]) * f - dy * w + gauss(rng) * pen.jitter,
      y: a[1] + (b[1] - a[1]) * f + dx * w + gauss(rng) * pen.jitter,
      t: t * 1000,
      pressure: 0.5,
    });
    if (s >= total) break;
    let dc = Math.min(s, total - s);
    for (const c of cornerS) dc = Math.min(dc, Math.abs(s - c));
    const slow = 0.25 + 0.75 * Math.min(1, dc / 10);
    const vary = 1 + 0.3 * Math.sin(t * 7 + (ph[2] as number));
    s = Math.min(total, s + pen.speed * slow * vary * pen.dt);
    t += pen.dt;
  }
  return out;
}

const rot = (p: Vec2, a: number, c: Vec2 = [0, 0]): Vec2 => [
  c[0] + p[0] * Math.cos(a) - p[1] * Math.sin(a),
  c[1] + p[0] * Math.sin(a) + p[1] * Math.cos(a),
];

/**
 * Polyline path through `v` with overshoot `over` (mm) past each interior corner: the pen
 * runs past the corner along the incoming edge and the next edge starts from there.
 * `closed`: back to the start, ending `endGap` mm short of it (negative: overlapping past it).
 */
export function polylinePath(
  v: readonly Vec2[],
  options: { closed?: boolean; over?: number; endGap?: number; hooks?: boolean } = {},
): { path: Vec2[]; corners: number[] } {
  const pts = options.closed ? [...v, v[0] as Vec2] : [...v];
  const over = options.over ?? 0;
  const path: Vec2[] = [pts[0] as Vec2];
  const corners: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Vec2;
    const b = pts[i] as Vec2;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    const lastEdge = i === pts.length - 1;
    if (lastEdge) {
      const g = options.closed ? (options.endGap ?? 0) : 0;
      path.push([b[0] - d[0] * g, b[1] - d[1] * g]);
    } else {
      corners.push(path.length);
      path.push([b[0] + d[0] * over, b[1] + d[1] * over]);
      if (options.hooks) path.push(b);
    }
  }
  return { path: densify(path), corners: corners.map((c) => c * DENSE) };
}

const DENSE = 20;
function densify(p: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i] as Vec2;
    const b = p[i + 1] as Vec2;
    for (let k = 0; k < DENSE; k++) {
      const t = k / DENSE;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  out.push(p[p.length - 1] as Vec2);
  return out;
}

/** Ellipse-ish arc path: radii (rx, ry), rotation, from angle a0 sweeping `sweep` (signed). */
export function arcPath(
  c: Vec2,
  rx: number,
  ry: number,
  rotation: number,
  a0: number,
  sweepAngle: number,
): Vec2[] {
  const n = Math.max(16, Math.ceil(Math.abs(sweepAngle) / (2 * DEG)));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweepAngle * i) / n;
    out.push(rot([rx * Math.cos(a), ry * Math.sin(a)], rotation, c));
  }
  return out;
}

export type Label =
  | 'line'
  | 'polyline'
  | 'rectangle'
  | 'circle'
  | 'arc'
  | 'scribble'
  | 'ellipse'
  | 'spline';

export interface Generated {
  label: Label;
  /** What was drawn, for assertions. */
  note: string;
  samples: StrokeSample[];
  /** Ideal geometry (vertices / centre & radius / sweep sign). */
  truth: {
    vertices?: Vec2[];
    center?: Vec2;
    radius?: number;
    ccw?: boolean;
    angle?: number;
    /** Ellipses: radii and major-axis direction. */
    radii?: [number, number];
    path?: Vec2[];
  };
}

const origin = (rng: Rng): Vec2 => [range(rng, -200, 200), range(rng, -200, 200)];
const sign = (rng: Rng): number => (rng() < 0.5 ? -1 : 1);

export function genLine(rng: Rng, angle = range(rng, 0, Math.PI)): Generated {
  const o = origin(rng);
  const l = range(rng, 30, 120);
  const v = [o, rot([l, 0], angle, o)];
  const { path, corners } = polylinePath(v);
  return {
    label: 'line',
    note: `line ${l.toFixed(0)} mm at ${(angle / DEG).toFixed(1)}°`,
    samples: penStroke(path, corners, rng),
    truth: { vertices: v, angle },
  };
}

/** Open polyline with 2–4 segments, turns 45–135° (either way). */
export function genPolyline(rng: Rng, segments = 2 + Math.floor(rng() * 3)): Generated {
  const o = origin(rng);
  let v: Vec2[] = [o];
  // Open means open: redraw when an end lands near the other end's segment (that would close).
  const closesBack = (q: Vec2[]) =>
    segDist(q[q.length - 1] as Vec2, q[0] as Vec2, q[1] as Vec2) < 20 ||
    segDist(q[0] as Vec2, q[q.length - 2] as Vec2, q[q.length - 1] as Vec2) < 20;
  for (let attempt = 0; attempt === 0 || closesBack(v); attempt++) {
    let dir = range(rng, 0, 2 * Math.PI);
    v = [o];
    for (let i = 0; i < segments; i++) {
      const prev = v[v.length - 1] as Vec2;
      v.push(rot([range(rng, 30, 70), 0], dir, prev));
      dir += sign(rng) * range(rng, 45, 135) * DEG;
    }
  }
  const { path, corners } = polylinePath(v, { over: range(rng, 0, 2) });
  return {
    label: 'polyline',
    note: `open polyline, ${segments} segments`,
    samples: penStroke(path, corners, rng),
    truth: { vertices: v },
  };
}

/** Closed triangle, vertices anywhere (angles ≥ 30°). */
export function genTriangle(rng: Rng): Generated {
  const o = origin(rng);
  const r = range(rng, 25, 50);
  const a0 = range(rng, 0, 2 * Math.PI);
  const angles = [0, range(rng, 100, 140), range(rng, 220, 260)].map((a) => a0 + a * DEG);
  const v = angles.map((a) => rot([r, 0], a, o));
  if (rng() < 0.5) v.reverse();
  const { path, corners } = polylinePath(v, {
    closed: true,
    over: range(rng, 0, 2),
    endGap: range(rng, -1.5, 1.2),
  });
  return {
    label: 'polyline',
    note: 'closed triangle',
    samples: penStroke(path, corners, rng),
    truth: { vertices: v },
  };
}

export function genRectangle(rng: Rng, rotation?: number, hooks = false): Generated {
  const o = origin(rng);
  const w = range(rng, 25, 90);
  const h = range(rng, 25, 90);
  const angle = rotation ?? (rng() < 0.5 ? range(rng, -3, 3) * DEG : range(rng, 15, 75) * DEG);
  let v: Vec2[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ].map((p) => rot(p as Vec2, angle, o));
  if (rng() < 0.5) v = [v[0] as Vec2, v[3] as Vec2, v[2] as Vec2, v[1] as Vec2];
  const start = Math.floor(rng() * 4);
  v = [...v.slice(start), ...v.slice(0, start)];
  const { path, corners } = polylinePath(v, {
    closed: true,
    // Overshoot ≤ 6% of the short side (it tilts every edge the same way by over/side).
    over: range(rng, 0.5, Math.min(3, 0.06 * Math.min(w, h))),
    endGap: range(rng, -1.5, 1.2),
    hooks,
  });
  return {
    label: 'rectangle',
    note: `rectangle ${w.toFixed(0)}×${h.toFixed(0)} at ${(angle / DEG).toFixed(1)}°`,
    samples: penStroke(path, corners, rng),
    truth: { vertices: v, angle },
  };
}

export function genCircle(rng: Rng): Generated {
  const c = origin(rng);
  const r = range(rng, 12, 60);
  // Hand-drawn circles are slightly out of round (≤ 6%).
  const squash = range(rng, 1, 1.06);
  const ccw = rng() < 0.5;
  const overlap = range(rng, -1 / r, 15 * DEG);
  const path = arcPath(
    c,
    r * squash,
    r / squash,
    range(rng, 0, Math.PI),
    range(rng, 0, 2 * Math.PI),
    (ccw ? 1 : -1) * (2 * Math.PI + overlap),
  );
  return {
    label: 'circle',
    note: `circle r=${r.toFixed(0)}`,
    samples: penStroke(path, [], rng),
    truth: { center: c, radius: r, ccw },
  };
}

export function genArc(rng: Rng, sweepDeg = range(rng, 70, 260), ccw = rng() < 0.5): Generated {
  const c = origin(rng);
  const r = range(rng, 15, 60);
  const path = arcPath(c, r, r, 0, range(rng, 0, 2 * Math.PI), (ccw ? 1 : -1) * sweepDeg * DEG);
  return {
    label: 'arc',
    note: `arc r=${r.toFixed(0)} sweep ${sweepDeg.toFixed(0)}° ${ccw ? 'ccw' : 'cw'}`,
    samples: penStroke(path, [], rng),
    truth: { center: c, radius: r, ccw },
  };
}

/** Oval (ellipse) with the given aspect ratio, closed. */
export function genOval(rng: Rng, ratio: number): Generated {
  const c = origin(rng);
  const b = range(rng, 15, 40);
  const path = arcPath(
    c,
    b * ratio,
    b,
    range(rng, 0, Math.PI),
    range(rng, 0, 2 * Math.PI),
    2 * Math.PI + 5 * DEG,
  );
  return {
    label: 'polyline',
    note: `oval ${ratio.toFixed(2)}:1`,
    samples: penStroke(path, [], rng),
    truth: { center: c },
  };
}

/** M3.5: an ellipse (oval) of the given aspect ratio, closed, labelled as such. */
export function genEllipse(rng: Rng, ratio = range(rng, 1.4, 3)): Generated {
  const c = origin(rng);
  const b = range(rng, 15, 35);
  const rotation = range(rng, 0, Math.PI);
  const path = arcPath(
    c,
    b * ratio,
    b,
    rotation,
    range(rng, 0, 2 * Math.PI),
    (rng() < 0.5 ? 1 : -1) * (2 * Math.PI + 4 * DEG),
  );
  return {
    label: 'ellipse',
    note: `ellipse ${ratio.toFixed(2)}:1 at ${(rotation / DEG).toFixed(0)}°`,
    samples: penStroke(path, [], rng),
    truth: { center: c, radii: [b * ratio, b], angle: rotation },
  };
}

/** M3.5: a smooth open wave (one or two S-bends), labelled spline. */
export function genWave(rng: Rng): Generated {
  const o = origin(rng);
  const len = range(rng, 70, 140);
  const amp = range(rng, 0.08, 0.2) * len;
  const waves = 0.75 + rng() * 0.5;
  const angle = range(rng, 0, Math.PI);
  const ph = range(rng, 0, Math.PI / 2);
  const path: Vec2[] = [];
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    path.push(rot([t * len, amp * Math.sin(2 * Math.PI * waves * t + ph)], angle, o));
  }
  return {
    label: 'spline',
    note: `wave ${len.toFixed(0)} mm, ${waves.toFixed(2)} waves`,
    samples: penStroke(path, [], rng),
    truth: { path },
  };
}

/** M3.5: a smooth closed blob with 3–4 lobes (no circle, no ellipse), labelled spline. */
export function genBlob(rng: Rng): Generated {
  const c = origin(rng);
  const r = range(rng, 20, 45);
  const lobes = 3 + Math.floor(rng() * 2);
  const depth = range(rng, 0.15, 0.3);
  const ph = range(rng, 0, 2 * Math.PI);
  const path: Vec2[] = [];
  const n = 240;
  const dir = rng() < 0.5 ? 1 : -1;
  for (let i = 0; i <= n + 6; i++) {
    const t = (dir * 2 * Math.PI * i) / n;
    const rr = r * (1 + depth * Math.sin(lobes * t + ph));
    path.push([c[0] + rr * Math.cos(t), c[1] + rr * Math.sin(t)]);
  }
  return {
    label: 'spline',
    note: `blob r=${r.toFixed(0)}, ${lobes} lobes`,
    samples: penStroke(path, [], rng),
    truth: { center: c, path },
  };
}

/** Erase gesture: 5–8 fast back-and-forth passes drifting sideways, rounded reversals. */
export function genScribble(rng: Rng): Generated {
  const o = origin(rng);
  const w = range(rng, 20, 50);
  const passes = 5 + Math.floor(rng() * 4);
  const drift = range(rng, 0.08, 0.2) * w;
  const angle = range(rng, 0, Math.PI);
  const path: Vec2[] = [];
  for (let i = 0; i < passes; i++) {
    const y = i * drift;
    const [x0, x1] = i % 2 === 0 ? [0, w] : [w, 0];
    for (let k = 0; k <= 12; k++) path.push([x0 + ((x1 - x0) * k) / 12, y + (drift * k) / 24]);
    if (i + 1 < passes) {
      // A tight U-turn.
      const cx = x1;
      const cy = y + drift * 0.75;
      for (let k = 1; k < 6; k++) {
        const a = -Math.PI / 2 + (Math.PI * k) / 6;
        const sx = i % 2 === 0 ? 1 : -1;
        path.push([cx + sx * Math.cos(a) * drift * 0.25, cy + Math.sin(a) * drift * 0.25]);
      }
    }
  }
  const p = path.map((q) => rot(q, angle, o));
  return {
    label: 'scribble',
    note: `scribble, ${passes} passes`,
    samples: penStroke(p, [], rng, { ...currentPen, speed: currentPen.speed * 1.8 }),
    truth: {},
  };
}

/** A zigzag line: teeth with 60–100° apex angles, progressing along one direction. */
export function genZigzag(rng: Rng): Generated {
  const o = origin(rng);
  const teeth = 3 + Math.floor(rng() * 3);
  const apex = range(rng, 60, 100) * DEG;
  const amp = range(rng, 10, 20);
  const pitch = 2 * amp * Math.tan(apex / 2);
  const angle = range(rng, 0, Math.PI);
  const v: Vec2[] = [];
  for (let i = 0; i <= teeth * 2; i++) v.push(rot([(i * pitch) / 2, i % 2 ? amp : 0], angle, o));
  const { path, corners } = polylinePath(v, { over: range(rng, 0, 1.5) });
  return {
    label: 'polyline',
    note: `zigzag, ${teeth} teeth, apex ${(apex / DEG).toFixed(0)}°`,
    samples: penStroke(path, corners, rng),
    truth: { vertices: v },
  };
}

/** The mixed corpus for the confusion matrix: `perClass` strokes of each label. */
export function corpus(seed: number, perClass: number): Generated[] {
  const rng = seeded(seed);
  const out: Generated[] = [];
  for (let i = 0; i < perClass; i++) {
    out.push(genLine(rng));
    out.push([genPolyline, genTriangle, genZigzag][i % 3]?.(rng) as Generated);
    out.push(genRectangle(rng, undefined, i % 4 === 3));
    out.push(genCircle(rng));
    out.push(genArc(rng));
    out.push(genScribble(rng));
  }
  return out;
}
