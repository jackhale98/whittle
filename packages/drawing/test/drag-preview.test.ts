/**
 * What the editor needs to preview a drag without a rebuild (ADR-094): the groups that move with a
 * view carry `data-host`, one placement can be laid out again with a changed layout, and the items
 * of a preview render as plain nodes.
 */
import { describe, expect, it } from 'vitest';
import { svgItems, svgModel } from '../src/svg';
import { bracketBuild } from './fixtures';

const build = bracketBuild();
const sheet = build.sheets[0];
if (!sheet) throw new Error('no sheet');

describe('drag preview support', () => {
  it('relayout lays out one placement with the layout it is given, leaving the build alone', () => {
    const p1 = build.placed.find((p) => p.placementId === 'p1');
    expect(p1).toBeDefined();
    const before = JSON.stringify(build.placed);
    const moved = build.relayout({
      id: 'p1',
      viewId: 'V1',
      annotationId: 'A1',
      layout: { kind: 'lane', side: 'bottom', lane: 2 },
    });
    expect(moved).toBeDefined();
    const y = (items: (typeof build.placed)[number]['items']) =>
      Math.min(...items.flatMap((i) => (i.kind === 'line' ? [i.a[1], i.b[1]] : [])));
    // Two lanes further out, below the view.
    expect(y(moved?.items ?? [])).toBeLessThan(y(p1?.items ?? []));
    expect(moved?.textBox.length).toBe(4);
    expect(JSON.stringify(build.placed)).toBe(before);
    // The text side is honoured by the same call.
    const above = build.relayout({
      id: 'p1',
      viewId: 'V1',
      annotationId: 'A1',
      layout: { kind: 'lane', side: 'bottom', lane: 0 },
      text: { side: 'above' },
    });
    const below = build.relayout({
      id: 'p1',
      viewId: 'V1',
      annotationId: 'A1',
      layout: { kind: 'lane', side: 'bottom', lane: 0 },
      text: { side: 'below' },
    });
    const ty = (r: typeof above) => (r?.textBox ?? []).reduce((s, v) => s + v[1], 0) / 4;
    expect(ty(above)).toBeGreaterThan(ty(below));
    // A placement of a view that is not in the build is not laid out.
    expect(
      build.relayout({
        id: 'x',
        viewId: 'nope',
        annotationId: 'A1',
        layout: { kind: 'lane', side: 'top', lane: 0 },
      }),
    ).toBeUndefined();
  });

  it('a leader attached to a dragged placement follows it (the moved one passed in)', () => {
    const p3 = build.relayout({
      id: 'p3',
      viewId: 'V2',
      annotationId: 'A3',
      layout: { kind: 'radial', angle: 200, distance: 7 },
    });
    if (!p3) throw new Error('no p3');
    const stored = build.placed.find((p) => p.placementId === 'p5');
    const frame = {
      id: 'p5',
      viewId: 'V2',
      annotationId: 'A5',
      layout: {
        kind: 'leader' as const,
        attach: { kind: 'placement' as const, placementId: 'p3' },
        text: [0, 0] as [number, number],
      },
    };
    const still = build.relayout(frame);
    const follows = build.relayout(frame, new Map([['p3', p3]]));
    const minX = (b: [number, number][] | undefined) => Math.min(...(b ?? []).map((q) => q[0]));
    const minY = (b: [number, number][] | undefined) => Math.min(...(b ?? []).map((q) => q[1]));
    // Without the moved target it stays where the build had it; with it, it sits under its text.
    expect(minX(still?.textBox)).toBeCloseTo(minX(stored?.textBox), 9);
    expect(minX(follows?.textBox)).toBeCloseTo(minX(p3.textBox), 6);
    expect(Math.max(...(follows?.textBox ?? []).map((q) => q[1]))).toBeLessThan(minY(p3.textBox));
  });

  it('every group that moves with a view says which view it is drawn in', () => {
    const model = svgModel(sheet.list, { lineGroup: 'iso-0.5' });
    const flip = model.children?.[0] as { children: { attrs: Record<string, string> }[] };
    const groups = flip.children;
    const host = (key: string) =>
      groups.filter((g) => g.attrs['data-source'] === key).map((g) => g.attrs['data-host']);
    // A view's own geometry and its placements are drawn in that view's space.
    expect(host('view:V1')).toContain('V1');
    expect(host('placement:p1')).toEqual(['V1']);
    // A section's cutting plane is drawn on its parent: a separate group hosted by the parent.
    const section = build.views.get('V4');
    if (!section?.ok || section.view.kind !== 'section') throw new Error('no section');
    const hosts = host(`view:${section.view.id}`);
    expect(hosts).toContain(section.view.id);
    expect(hosts).toContain(section.view.parentId);
    // The template and the title block belong to no view.
    expect(
      groups
        .filter((g) => g.attrs['data-source'] === 'titleBlock:title')
        .every((g) => !g.attrs['data-host']),
    ).toBe(true);
  });

  it('svgItems are plain nodes: no grouping, the same strokes', () => {
    const p1 = build.placed.find((p) => p.placementId === 'p1');
    const nodes = svgItems(p1?.items ?? [], { lineGroup: 'iso-0.5' });
    expect(nodes.length).toBe(p1?.items.length);
    expect(nodes.every((n) => n.attrs['data-source'] === undefined)).toBe(true);
    expect(nodes.some((n) => n.tag === 'text')).toBe(true);
  });
});
