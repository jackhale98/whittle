import { describe, expect, it } from 'vitest';
import type { DisplayList } from '../src/annotation';
import { renderSvg, type SvgNode, serializeSvg, svgModel } from '../src/svg';
import { bracketBuild } from './fixtures';

const style = { lineGroup: 'iso-0.5' as const };

function walk(n: SvgNode, f: (n: SvgNode) => void): void {
  f(n);
  for (const c of n.children ?? []) if (typeof c !== 'string') walk(c, f);
}

describe('SVG editor model', () => {
  const list: DisplayList = {
    width: 420,
    height: 297,
    items: [
      {
        kind: 'line',
        a: [0, 0],
        b: [10, 0],
        role: 'visible',
        source: { kind: 'view', viewId: 'V1', edge: 'e1' },
      },
      {
        kind: 'line',
        a: [0, 5],
        b: [10, 5],
        role: 'hidden',
        source: { kind: 'view', viewId: 'V1' },
      },
      {
        kind: 'arc',
        center: [5, 5],
        radius: 2,
        start: 0,
        end: Math.PI,
        role: 'visible',
        source: { kind: 'view', viewId: 'V1' },
      },
      {
        kind: 'text',
        at: [20, 20],
        text: '<10 & "x">',
        height: 3.5,
        angle: 90,
        align: 'center',
        baseline: 'middle',
        role: 'text',
        attention: true,
        source: { kind: 'placement', placementId: 'P1', annotationId: 'A1' },
      },
    ],
  };
  const model = svgModel(list, style);

  it('is the sheet in mm with one y flip at the root', () => {
    expect(model.attrs).toMatchObject({ width: '420mm', height: '297mm', viewBox: '0 0 420 297' });
    const root = model.children?.[0] as SvgNode;
    expect(root.attrs.transform).toBe('matrix(1 0 0 -1 0 297)');
    expect(root.attrs.style).toBe('font-kerning:none');
  });
  it('groups items by source for picking', () => {
    const root = model.children?.[0] as SvgNode;
    const keys = (root.children as SvgNode[]).map((g) => g.attrs['data-source']);
    expect(keys).toEqual(['view:V1', 'placement:P1']);
    expect((root.children as SvgNode[])[1]?.attrs['data-attention']).toBe('true');
  });
  it('maps roles to widths and dashes, arcs to paths, text unflipped', () => {
    const nodes: SvgNode[] = [];
    walk(model, (n) => nodes.push(n));
    const lines = nodes.filter((n) => n.tag === 'line');
    expect(lines[0]?.attrs['stroke-width']).toBe('0.5');
    expect(lines[1]?.attrs['stroke-dasharray']).toBe('3 0.75');
    expect(nodes.find((n) => n.tag === 'path')?.attrs.d).toBe('M7 5A2 2 0 0 1 3 5');
    const text = nodes.find((n) => n.tag === 'text') as SvgNode;
    expect(text.attrs.transform).toBe('translate(20 20) scale(1 -1) rotate(-90)');
    expect(text.attrs['text-anchor']).toBe('middle');
    expect(text.attrs.fill).toBe('#d0342c');
    expect(Number(text.attrs['font-size'])).toBeCloseTo((3.5 * 2048) / 1515, 3);
  });
  it('serialises with escaping', () => {
    const s = serializeSvg(model);
    expect(s).toContain('&lt;10 &amp; &quot;x&quot;&gt;');
    expect(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });
  it('renders the bracket sheet', () => {
    const svg = renderSvg(bracketBuild().sheets[0]!.list, style, { paper: '#fff' });
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('data-source="placement:p1"');
    expect(svg).toContain('>BRK-001<');
  });
});
