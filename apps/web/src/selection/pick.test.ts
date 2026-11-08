import type { EntityQuery, Feature, FilletFeature, PickHit } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { contextTools, newExtrude, newFillet, nextName } from '../features/factories';
import { acceptsFor, applyPick, refForHit, resolvePick, toleranceFor, vertexAt } from './pick';

const hit = (p: Partial<PickHit>): PickHit => ({
  bodyId: 'B1',
  kind: 'face',
  index: 0,
  point: [0, 0, 0],
  distancePx: 0,
  ...p,
});

describe('picking', () => {
  it('tolerance by pointer type', () => {
    expect(toleranceFor('mouse')).toBe(6);
    expect(toleranceFor('pen')).toBe(10);
    expect(toleranceFor('touch')).toBe(22);
  });

  it('thin things beat faces; near-ties among thin hits ask "Which one?"', () => {
    const face = hit({ kind: 'face', distancePx: 0 });
    const edge = hit({ kind: 'edge', index: 3, distancePx: 3 });
    expect(resolvePick([face, edge]).best).toBe(edge);
    expect(resolvePick([face, edge]).ties).toEqual([]);
    const edge2 = hit({ kind: 'edge', index: 4, distancePx: 4 });
    const r = resolvePick([face, edge, edge2]);
    expect(r.ties.map((h) => h.index)).toEqual([3, 4]);
    const vertex = hit({ kind: 'vertex', index: 1, distancePx: 3.5 });
    expect(resolvePick([edge, vertex]).best).toBe(vertex);
    expect(resolvePick([edge, vertex]).ties).toHaveLength(2);
    // Kind filters (e.g. fillet picks edges only).
    expect(resolvePick([face, vertex], { kinds: ['edge'] }).best).toBeNull();
  });

  it('touch: a tap on a face selects the face unless it lands right on an edge or vertex', () => {
    const face = hit({ kind: 'face', distancePx: 0 });
    const nearEdge = hit({ kind: 'edge', index: 3, distancePx: 6 });
    const farEdge = hit({ kind: 'edge', index: 4, distancePx: 15 });
    const farVertex = hit({ kind: 'vertex', index: 1, distancePx: 18 });
    const touch = { pointerType: 'touch' };
    // A small face ringed by edges within the 22 px finger tolerance still wins…
    expect(resolvePick([face, farEdge, farVertex], touch).best).toBe(face);
    // …but a tap right on an edge picks the edge.
    expect(resolvePick([face, nearEdge, farEdge], touch).best).toBe(nearEdge);
    // Off the part (no face under the finger) the full tolerance still finds thin things.
    expect(resolvePick([farEdge, farVertex], touch).best).toBe(farVertex);
    // Edge-only tools (fillet) keep the full tolerance: faces are filtered out first.
    expect(resolvePick([face, farEdge], { ...touch, kinds: ['edge'] }).best).toBe(farEdge);
  });

  it('a visible sketch region over a face wins the tap; the face elsewhere stays pickable', () => {
    const face = hit({ kind: 'face', distancePx: 0 });
    const region = hit({ kind: 'region', bodyId: 'S1', entity: 'SS1:region(a)', distancePx: 0 });
    expect(resolvePick([face, region]).best).toBe(region);
    expect(resolvePick([region, face]).ties).toEqual([]);
    expect(resolvePick([face]).best).toBe(face);
  });

  it('selection → EntityRef: sketch picks locally, body picks via refFor', async () => {
    const queries: EntityQuery[] = [];
    const refFor = async (_p: string, q: EntityQuery) => {
      queries.push(q);
      return { name: `edge#${q.index}`, kind: q.kind };
    };
    expect(
      await refForHit(hit({ kind: 'region', bodyId: 'S1', entity: 'S1:region(a,b)' }), 'P', refFor),
    ).toEqual({ name: 'S1:region(a,b)', kind: 'region' });
    expect(
      await refForHit(hit({ kind: 'sketchCurve', bodyId: 'K', entity: 'L1' }), 'P', refFor),
    ).toEqual({
      name: 'SK:e(L1)',
      kind: 'edge',
    });
    expect(await refForHit(hit({ kind: 'edge', index: 7 }), 'P', refFor)).toEqual({
      name: 'edge#7',
      kind: 'edge',
    });
    expect(queries).toEqual([{ bodyId: 'B1', kind: 'edge', index: 7 }]);
    expect(await refForHit(hit({ kind: 'face' }), 'P', refFor, 'body')).toEqual({
      name: 'B1',
      kind: 'body',
    });
  });

  it('onPick paths: /edges appends (deduped), /edges/1 replaces, scalar paths set', () => {
    const part = { features: [] as Feature[] };
    let f: FilletFeature = newFillet(part, [{ name: 'e0', kind: 'edge' }]);
    f = applyPick(f, '/edges', { name: 'e1', kind: 'edge' });
    f = applyPick(f, '/edges', { name: 'e1', kind: 'edge' });
    expect(f.edges.map((e) => e.name)).toEqual(['e0', 'e1']);
    f = applyPick(f, '/edges/1', { name: 'e9', kind: 'edge' });
    expect(f.edges.map((e) => e.name)).toEqual(['e0', 'e9']);
    const ex = applyPick(newExtrude(part, [], 0), '/end/target', { name: 'face', kind: 'face' });
    expect(ex.end).toEqual({ kind: 'blind', depth: '10 mm' }); // not upTo: path absent, unchanged
    expect(acceptsFor('/edges/2').kinds).toEqual(['edge']);
    expect(acceptsFor('/tools').as).toBe('body');
  });

  it('names and context tools', () => {
    const part = { features: [{ name: 'Extrude 1' }, { name: 'Extrude 4' }] as Feature[] };
    expect(nextName(part, 'extrude')).toBe('Extrude 5');
    expect(nextName(part, 'fillet')).toBe('Fillet 1');
    expect(contextTools(['region', 'region'])).toEqual(['extrude', 'revolve']);
    expect(contextTools(['edge'])).toEqual(['fillet', 'chamfer']);
    expect(contextTools(['face'])).toEqual(['sketch', 'pushPull']);
    expect(contextTools(['face', 'face'])).toEqual(['pushPull']);
    expect(contextTools(['face', 'edge'])).toEqual([]);
  });

  it('a selected vertex is re-found by position after a regen, or dropped if it moved', () => {
    const pos = new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0]);
    expect(vertexAt(pos, [10, 20, 0])).toBe(2);
    expect(vertexAt(pos, [10.0004, 20, 0])).toBe(2); // float noise
    expect(vertexAt(pos, [10, 25, 0])).toBe(-1); // moved: never guessed
    expect(vertexAt(undefined, [0, 0, 0])).toBe(-1);
  });
});
