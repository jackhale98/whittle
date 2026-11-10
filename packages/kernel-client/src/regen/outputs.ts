/**
 * Regen outputs: body results (mesh copies named from the naming map, mass properties) and
 * sketch results (world-space curves, points and region meshes).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  BodyResult,
  Frame,
  MeshQuality,
  NamingMap,
  Part,
  SketchResult,
  Vec2,
  Vec3,
  WrenDoc,
} from '@wren-cad/contracts';
import { expressionEngine, scopeOf, tryResolveDensity } from '@wren-cad/document';
import { copyMesh, faceIndex, faceSubMesh } from './buffers';
import type { EngineCore } from './core';
import { sampleEntity, toWorld } from './geometry';
import type { BodyState, SketchState } from './state';

export function densityOf(part: Part, doc: WrenDoc): number | undefined {
  if (!part.material) return undefined;
  const d = tryResolveDensity(part.material, expressionEngine, scopeOf(doc));
  return d.ok ? d.value : undefined;
}

export async function bodyResult(
  core: EngineCore,
  b: BodyState,
  quality: MeshQuality,
  wantMass: boolean,
  density: number | undefined,
): Promise<BodyResult | null> {
  const mesh = await core.meshOf(b.shape, quality);
  if (!mesh) return null;
  const out: BodyResult = { id: b.id, shape: b.shape, mesh: copyMesh(mesh) };
  // Names from the body's naming map: the kernel's mesh names are its internal ones (imports
  // are translated, mesh-only bodies are named by the engine).
  out.mesh.faceNames = namesByIndex(b.naming, 'face', out.mesh.faceRanges.length / 2);
  out.mesh.edgeNames = namesByIndex(b.naming, 'edge', out.mesh.edgeRanges.length / 2);
  if (wantMass) {
    const mp = await core.massOf(b.shape, density);
    if (mp) out.massProperties = mp;
  }
  return out;
}

export async function sketchResult(
  core: EngineCore,
  s: SketchState,
  quality: MeshQuality,
): Promise<SketchResult> {
  const points = new Map<string, Vec2>();
  for (const e of s.entities) if (e.kind === 'point') points.set(e.id, [e.x, e.y]);
  // Chord tolerance from the sketch's extent so display matches the viewport quality.
  let extent = 0;
  for (const p of points.values()) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]));
  for (const e of s.entities) {
    if (e.kind === 'circle') extent = Math.max(extent, e.radius);
    if (e.kind === 'ellipse' || e.kind === 'ellipticArc') {
      extent = Math.max(extent, e.majorRadius, e.minorRadius);
    }
  }
  const chord = Math.max(1e-4, (extent || 10) * core.quality[quality].linearDeflection);
  const curves: SketchResult['curves'] = [];
  const pts: NonNullable<SketchResult['points']> = [];
  for (const e of s.entities) {
    if (e.kind === 'point') {
      pts.push({ entity: e.id, at: toWorld(s.frame, e.x, e.y), construction: e.construction });
      continue;
    }
    const samples = sampleEntity(e, points, chord);
    const arr = new Float32Array(samples.length * 3);
    samples.forEach((uv, i) => {
      arr.set(toWorld(s.frame, uv[0], uv[1]), 3 * i);
    });
    curves.push({ entity: e.id, points: arr, construction: e.construction });
  }
  const regions: SketchResult['regions'] = [];
  const mesh = s.regions.length > 0 ? await core.meshOf(s.shape, quality) : null;
  for (const name of s.regions) {
    const fi = faceIndex(s.naming, name);
    if (mesh && fi >= 0) regions.push({ name, mesh: faceSubMesh(mesh, fi, name) });
  }
  return {
    featureId: s.id,
    curves,
    points: pts,
    regions,
    frame: { origin: s.frame.origin, x: s.frame.x, y: crossY(s.frame), z: s.frame.z },
  };
}

function crossY(f: Frame): Vec3 {
  const y: Vec3 = [
    f.z[1] * f.x[2] - f.z[2] * f.x[1],
    f.z[2] * f.x[0] - f.z[0] * f.x[2],
    f.z[0] * f.x[1] - f.z[1] * f.x[0],
  ];
  return y.map((v) => (v === 0 ? 0 : v)) as Vec3; // no -0
}

/** The first name per index of `kind` (aliases come later in a naming map), "" when unnamed. */
function namesByIndex(naming: NamingMap, kind: 'face' | 'edge', count: number): string[] {
  const out: string[] = Array(count).fill('');
  for (let i = naming.length - 1; i >= 0; i--) {
    const n = naming[i] as NamingMap[number];
    if (n.kind === kind && n.index < count) out[n.index] = n.name;
  }
  return out;
}
