/**
 * Small helpers shared by the engine and the feature executors: errors, cache-key
 * definitions, the mesh-only refusal, the open-surface guard for imports and taint scopes.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, Id, KernelError, NamingMap, ShapeFingerprints } from '@wren-cad/contracts';

export const kerr = (
  code: KernelError['code'],
  message: string,
  extra: Partial<Omit<KernelError, 'code' | 'message'>> = {},
): KernelError => ({ code, message, ...extra });

/**
 * A feature's definition for cache keys: without its name, suppression and viewport visibility
 * (ADR-093: showing or hiding a plane never rebuilds anything). Annotations are part-level
 * (ADR-090), so nothing about them can reach a feature's key.
 */
export function definition(f: Feature): unknown {
  return { ...f, name: undefined, suppressed: undefined, visibility: undefined };
}

/** Ids of the features a mirror / pattern copies (they are not EntityRefs). */
export function copiedFeatures(f: Feature): Id[] {
  if (f.type !== 'mirror' && f.type !== 'linearPattern' && f.type !== 'circularPattern') return [];
  return f.source.kind === 'features' ? f.source.features : [];
}

/** Bodies a blocked feature would have acted on (conservative: all for body-modifying features). */
export function allBodiesFor(f: Feature, all: string[]): string[] {
  switch (f.type) {
    case 'sketch':
    case 'plane':
    case 'axis':
    case 'point':
    case 'thread':
      return [];
    case 'extrude':
    case 'revolve':
    case 'primitive':
    case 'sweep':
    case 'loft':
      if (f.op === 'new') return [`B${f.id}`];
      if (f.scope?.kind === 'bodies') return f.scope.bodies.map((b) => b.name);
      return all;
    case 'boolean':
      return [f.target.name, ...f.tools.map((t) => t.name)];
    case 'import':
      if (f.op === 'new') return [`B${f.id}`];
      if (f.scope?.kind === 'bodies') return f.scope.bodies.map((b) => b.name);
      return all;
    default:
      return all;
  }
}

/**
 * Does an imported body have free (boundary) edges? Its edges are named from their adjacent faces
 * (naming.ts): `edge(A|B)` between two faces, `edge(A|A)` on a seam, `edge(A)` on a free edge.
 * Degenerate edges (sphere poles, cone apexes, revolves touching the axis) are also named
 * `edge(A)` in a closed solid, so edges whose fingerprint curve is `degenerate` are not free.
 * Without fingerprints the body is assumed closed: a false "open" would refuse a valid solid.
 */
export function hasFreeEdges(
  naming: NamingMap,
  featureId: Id,
  fp: ShapeFingerprints | null,
): boolean {
  if (!fp) return false;
  const free = new RegExp(`^edge\\(F${featureId}:face(#\\d+)?\\)(#\\d+)?$`);
  return naming.some(
    (n) => n.kind === 'edge' && free.test(n.name) && fp.edges[n.index]?.curve !== 'degenerate',
  );
}

export function meshOnlyError(verb: string, bodyId: string): KernelError {
  return kerr('INVALID_INPUT', `A mesh reference body cannot be ${verb}`, {
    hint: 'Meshes (STL, OBJ, 3MF, GLB) are for reference only; import a STEP file to model on it.',
    entityRefs: [bodyId],
  });
}
