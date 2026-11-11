/**
 * Template goldens: provisional (secondary sources), owner D9. Re-verify against ISO 5457,
 * ISO 7200 and ASME Y14.1 once the standards are bought.
 */
import type { SheetFormat, TitleBlockSlot } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { standardPreset } from '../src/style';
import {
  ASME_ZONE_COUNTS,
  BOUND_SLOTS,
  boundSlotText,
  generateTemplate,
  ISO_5457_FIELD_COUNTS,
  LATEST_TEMPLATE_VERSION,
  resolveTitleBlock,
  sheetDimensions,
  type TemplateLayout,
  type TitleBlockData,
  titleBlockItems,
  UNBOUND_SLOTS,
  zoneAt,
} from '../src/template';

function layout(format: SheetFormat, id: 'iso-5457' | 'asme-y14.1' = 'iso-5457'): TemplateLayout {
  const r = generateTemplate(format, { id, version: 1 });
  if (!r.ok) throw new Error(r.message);
  return r.layout;
}

const data: TitleBlockData = {
  title: 'Bracket',
  partNumber: 'BRK-001',
  description: 'Mounting bracket',
  material: 'AlMg3',
  mass: 152.4,
  scale: 0.5,
  projection: 'first',
  units: 'mm',
  standard: standardPreset('iso'),
  revision: { name: 'A', released: false },
  sheet: { index: 1, count: 2 },
  date: '2026-11-11',
};

describe('ISO 5457 (provisional, secondary sources)', () => {
  it('A3 landscape: 420 × 297, margins 20/10, an 8 × 6 grid', () => {
    const l = layout({ size: 'A3', orientation: 'landscape' });
    expect([l.width, l.height]).toEqual([420, 297]);
    expect(l.frame).toEqual({ min: [20, 10], max: [410, 287] });
    expect(l.zones?.x.labels).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(l.zones?.y.labels).toEqual(['F', 'E', 'D', 'C', 'B', 'A']);
    // Fields are 50 mm from the centring marks; end fields take the rest.
    const xe = l.zones?.x.edges ?? [];
    expect(xe[4]).toBe(215);
    expect((xe[5] ?? 0) - (xe[4] ?? 0)).toBe(50);
  });
  it('reproduces the field-count table for A0–A4 in both orientations', () => {
    for (const [size, [long, short]] of Object.entries(ISO_5457_FIELD_COUNTS)) {
      const land = layout({ size: size as SheetFormat['size'], orientation: 'landscape' });
      expect([land.zones?.x.labels.length, land.zones?.y.labels.length], size).toEqual([
        long,
        short,
      ]);
      const port = layout({ size: size as SheetFormat['size'], orientation: 'portrait' });
      expect([port.zones?.x.labels.length, port.zones?.y.labels.length], size).toEqual([
        short,
        long,
      ]);
    }
  });
  it('skips I and O in zone letters', () => {
    const l = layout({ size: 'A0', orientation: 'landscape' });
    expect(l.zones?.y.labels.join('')).not.toMatch(/[IO]/);
    expect(l.zones?.y.labels.at(-1)).toBe('A');
  });
  it('custom sizes get a frame without zones', () => {
    const l = layout({ size: { width: 500, height: 300 }, orientation: 'landscape' });
    expect(l.zones).toBeUndefined();
    expect(l.frame.max).toEqual([490, 290]);
  });
  it('places a 180 mm ISO 7200 title block at the bottom-right of the frame with every slot', () => {
    const l = layout({ size: 'A4', orientation: 'portrait' });
    expect(l.titleBlock.box.max[0]).toBe(l.frame.max[0]);
    expect(l.titleBlock.box.min[1]).toBe(l.frame.min[1]);
    expect(l.titleBlock.box.max[0] - l.titleBlock.box.min[0]).toBe(180);
    const slots = new Set(l.titleBlock.cells.map((c) => c.slot));
    for (const s of UNBOUND_SLOTS) expect(slots.has(s), s).toBe(true);
    expect(slots.size).toBe(21);
  });
  it('title block cells tile the block without overlapping', () => {
    for (const id of ['iso-5457', 'asme-y14.1'] as const) {
      const l = layout({ size: id === 'iso-5457' ? 'A3' : 'ANSI-B', orientation: 'landscape' }, id);
      const tb = l.titleBlock;
      let area = 0;
      for (const [i, a] of tb.cells.entries()) {
        area += (a.box.max[0] - a.box.min[0]) * (a.box.max[1] - a.box.min[1]);
        expect(a.box.min[0] >= tb.box.min[0] - 1e-9 && a.box.max[1] <= tb.box.max[1] + 1e-9).toBe(
          true,
        );
        for (const b of tb.cells.slice(i + 1)) {
          const ox = Math.min(a.box.max[0], b.box.max[0]) - Math.max(a.box.min[0], b.box.min[0]);
          const oy = Math.min(a.box.max[1], b.box.max[1]) - Math.max(a.box.min[1], b.box.min[1]);
          expect(ox > 1e-9 && oy > 1e-9, `${a.slot}/${b.slot}`).toBe(false);
        }
      }
      const total = (tb.box.max[0] - tb.box.min[0]) * (tb.box.max[1] - tb.box.min[1]);
      expect(area).toBeCloseTo(total);
    }
  });
  it('has a 100 mm reference graduation in the margin', () => {
    const l = layout({ size: 'A4', orientation: 'portrait' });
    const g = l.graduation!;
    expect(Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1])).toBe(100);
    expect(g.start[0]).toBeLessThan(l.frame.min[0]);
    expect(l.items.filter((i) => i.source?.kind === 'scaleBar' && i.kind === 'line')).toHaveLength(
      12,
    );
  });
  it('draws centring marks with the 0.7 mm frame role', () => {
    const l = layout({ size: 'A3', orientation: 'landscape' });
    const marks = l.items.filter((i) => i.kind === 'line' && i.role === 'frame');
    expect(marks).toHaveLength(4);
  });
});

describe('ASME Y14.1 (provisional, secondary sources)', () => {
  it('ANSI sizes in inches convert exactly', () => {
    expect(sheetDimensions({ size: 'ANSI-A', orientation: 'landscape' })).toEqual({
      width: 279.4,
      height: 215.9,
    });
    expect(sheetDimensions({ size: 'ANSI-E', orientation: 'landscape' })).toEqual({
      width: 1117.6,
      height: 863.6,
    });
  });
  it('numbers zones right to left and letters them bottom to top', () => {
    const l = layout({ size: 'ANSI-D', orientation: 'landscape' }, 'asme-y14.1');
    expect(l.zones?.x.labels).toEqual(['8', '7', '6', '5', '4', '3', '2', '1']);
    expect(l.zones?.y.labels).toEqual(['A', 'B', 'C', 'D']);
    for (const [size, [nl, ns]] of Object.entries(ASME_ZONE_COUNTS)) {
      const z = layout(
        { size: size as SheetFormat['size'], orientation: 'landscape' },
        'asme-y14.1',
      ).zones;
      expect([z?.x.labels.length, z?.y.labels.length], size).toEqual([nl, ns]);
    }
  });
  it('uses 0.5 in margins on C–E and 0.38/0.25 in on A–B', () => {
    expect(layout({ size: 'ANSI-D', orientation: 'landscape' }, 'asme-y14.1').frame.min).toEqual([
      12.7, 12.7,
    ]);
    const b = layout({ size: 'ANSI-B', orientation: 'landscape' }, 'asme-y14.1').frame.min;
    expect(b[0]).toBeCloseTo(9.652);
    expect(b[1]).toBeCloseTo(6.35);
  });
});

describe('versions and zones', () => {
  it('pins the generator version and refuses newer ones', () => {
    expect(LATEST_TEMPLATE_VERSION['iso-5457']).toBe(1);
    const r = generateTemplate(
      { size: 'A3', orientation: 'landscape' },
      { id: 'iso-5457', version: 2 },
    );
    expect(r.ok).toBe(false);
  });
  it('finds the grid zone of a point', () => {
    const l = layout({ size: 'A3', orientation: 'landscape' });
    expect(zoneAt(l, [25, 280])).toBe('A1');
    expect(zoneAt(l, [400, 15])).toBe('F8');
    expect(zoneAt(l, [5, 5])).toBeNull();
  });
});

describe('title block slots', () => {
  const l = layout({ size: 'A3', orientation: 'landscape' });

  it('resolves bound slots from the data', () => {
    const r = resolveTitleBlock(l, data, {});
    const t = (s: TitleBlockSlot) => r.slots.get(s)?.text;
    expect(t('title')).toBe('Bracket');
    expect(t('scale')).toBe('1:2');
    expect(t('mass')).toBe('152.4 g');
    expect(t('sheet')).toBe('1 / 2');
    expect(t('configuration')).toBe('Default');
    expect(t('generalTolerance')).toBe('ISO 2768-mK');
    expect(r.slots.get('projection')?.symbol).toBe('projectionFirst');
  });
  it('shows an unreleased revision with * and "Not released" (Q3)', () => {
    const r = resolveTitleBlock(l, data, {});
    expect(r.slots.get('revision')?.text).toBe('A*');
    expect(r.slots.get('documentStatus')?.text).toBe('Not released');
    const rel = resolveTitleBlock(l, { ...data, revision: { name: 'B', released: true } }, {});
    expect(rel.slots.get('revision')?.text).toBe('B');
    expect(rel.slots.get('documentStatus')?.source).toBe('empty');
  });
  it('cascades unbound text sheet → drawing → project', () => {
    const r = resolveTitleBlock(l, data, {
      sheet: { drawnBy: 'Sheet' },
      drawing: { drawnBy: 'Drawing', checkedBy: 'Drawing' },
      project: { drawnBy: 'Project', checkedBy: 'Project', owner: 'ACME' },
    });
    expect(r.slots.get('drawnBy')).toMatchObject({ text: 'Sheet', source: 'text' });
    expect(r.slots.get('checkedBy')?.text).toBe('Drawing');
    expect(r.slots.get('owner')?.text).toBe('ACME');
    expect(r.slots.get('approvedBy')?.source).toBe('empty');
  });
  it('lets text override a bound slot and keeps the binding for the badge', () => {
    const r = resolveTitleBlock(l, data, { drawing: { material: 'See note 3' } });
    expect(r.slots.get('material')).toMatchObject({
      text: 'See note 3',
      source: 'override',
      bound: 'AlMg3',
    });
  });
  it('keeps text for slots the template lacks and lists it as unused', () => {
    const asme = layout({ size: 'ANSI-B', orientation: 'landscape' }, 'asme-y14.1');
    const r = resolveTitleBlock(asme, data, { drawing: { language: 'en' } });
    expect(r.unused).toEqual([{ slot: 'language', text: 'en' }]);
  });
  it('warns about identification numbers over 16 characters (ISO 7200)', () => {
    const r = resolveTitleBlock(l, { ...data, partNumber: 'ABCDEFGHIJKLMNOPQ' }, {});
    expect(r.slots.get('partNumber')?.warnings).toHaveLength(1);
  });
  it('renders captions, values and the projection symbol; shrinks long values', () => {
    const r = resolveTitleBlock(l, { ...data, description: 'x'.repeat(200) }, {});
    const out = titleBlockItems(l, r);
    const texts = out.items
      .filter((i) => i.kind === 'text')
      .map((i) => (i as { text: string }).text);
    expect(texts).toContain('Bracket');
    expect(texts).toContain('Title');
    expect(out.items.some((i) => i.kind === 'arc' && i.source?.kind === 'titleBlock')).toBe(true);
    expect(out.overflow).toEqual(['description']);
  });
  it('binds exactly the bound slots', () => {
    for (const s of BOUND_SLOTS) expect(boundSlotText(s, data), s).toBeTypeOf('string');
    for (const s of UNBOUND_SLOTS) expect(boundSlotText(s, data), s).toBeUndefined();
  });
});
