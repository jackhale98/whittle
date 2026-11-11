/**
 * Title block slot resolution (ADR-090 §3.3, `TitleBlockSlot`). Bound slots resolve from data at
 * render time; unbound slots take text that cascades sheet `fields` → drawing `template.fields` →
 * project `drawingDefaults.fields`. Text over a bound slot overrides the binding and is badged
 * (the binding stays visible). Text for a slot the template lacks is kept and listed as unused,
 * never dropped.
 *
 * The caller resolves the model data (part number with the M3.7 D4 fallback, material, mass from
 * the configuration's background build, releases) and passes it in, so this module needs no
 * document package.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  DrawingStandard,
  Projection,
  TitleBlockFields,
  TitleBlockSlot,
  Vec2,
} from '@wren-cad/contracts';
import type { DisplayItem } from '../annotation/display';
import { formatScale } from '../annotation/numbers';
import { placeSymbol, symbolGlyph } from '../annotation/symbols';
import { normalizeText, textWidth } from '../annotation/text';
import type { TemplateLayout } from './types';

export const BOUND_SLOTS: readonly TitleBlockSlot[] = [
  'title',
  'partNumber',
  'description',
  'material',
  'mass',
  'configuration',
  'scale',
  'projection',
  'units',
  'standard',
  'generalTolerance',
  'revision',
  'sheet',
  'date',
];

export const UNBOUND_SLOTS: readonly TitleBlockSlot[] = [
  'owner',
  'drawnBy',
  'checkedBy',
  'approvedBy',
  'documentType',
  'documentStatus',
  'language',
];

/** Model data for the bound slots, already resolved by the caller (for the sheet's configuration). */
export interface TitleBlockData {
  /** Document (drawing) title. */
  title: string;
  /** Part number with the M3.7 D4 fallback (`partNumberFor`). */
  partNumber: string;
  description?: string;
  material?: string;
  /** Mass in grams; `'building'` while the configuration's background build runs (ADR-079). */
  mass?: number | 'building';
  massUnit?: 'g' | 'kg';
  /** Configuration name; absent = Default. */
  configuration?: string;
  /** The sheet's scale, evaluated (unitless ratio). Absent = the expression failed. */
  scale?: number;
  projection: Projection;
  units: 'mm';
  standard: DrawingStandard;
  /** Release being exported, or the latest release with later changes (ADR-090 Q3). */
  revision?: { name: string; released: boolean };
  /** 1-based sheet number and count. */
  sheet: { index: number; count: number };
  /** ISO-8601 date (release or export). */
  date?: string;
}

export type SlotSource = 'bound' | 'text' | 'override' | 'empty';

export interface ResolvedSlot {
  slot: TitleBlockSlot;
  text: string;
  source: SlotSource;
  /** For `override`: what the binding would show (the badge on hover). */
  bound?: string;
  /** The projection slot draws the projection-method symbol. */
  symbol?: 'projectionFirst' | 'projectionThird';
  /** Problems the UI lists (identification number longer than 16 characters, ISO 7200). */
  warnings?: string[];
}

export interface TitleBlockResolution {
  slots: Map<TitleBlockSlot, ResolvedSlot>;
  /** Text stored for slots this template has no cell for (kept, listed, never dropped). */
  unused: { slot: TitleBlockSlot; text: string }[];
}

function massText(mass: TitleBlockData['mass'], unit: 'g' | 'kg' = 'g'): string {
  if (mass === undefined) return '';
  if (mass === 'building') return 'building…';
  const v = unit === 'kg' ? mass / 1000 : mass;
  // Four significant figures: 152.4 g, 1.234 kg, 0.8125 g.
  return `${Number(v.toPrecision(4))} ${unit}`;
}

/** What each bound slot shows from the data. */
export function boundSlotText(slot: TitleBlockSlot, d: TitleBlockData): string | undefined {
  switch (slot) {
    case 'title':
      return d.title;
    case 'partNumber':
      return d.partNumber;
    case 'description':
      return d.description ?? '';
    case 'material':
      return d.material ?? '';
    case 'mass':
      return massText(d.mass, d.massUnit);
    case 'configuration':
      return d.configuration ?? 'Default';
    case 'scale':
      return d.scale === undefined ? '?' : formatScale(d.scale);
    case 'projection':
      return d.projection === 'first' ? 'First angle' : 'Third angle';
    case 'units':
      return d.units;
    case 'standard':
      return d.standard.family === 'iso' ? 'ISO' : d.standard.gps;
    case 'generalTolerance':
      return d.standard.generalTolerance ?? '';
    case 'revision':
      return d.revision ? `${d.revision.name}${d.revision.released ? '' : '*'}` : '';
    case 'sheet':
      return `${d.sheet.index} / ${d.sheet.count}`;
    case 'date':
      return d.date ?? '';
    default:
      return undefined;
  }
}

/**
 * Resolves every slot of a template: text cascade first (sheet → drawing → project), then the
 * binding. Unreleased output shows the last release with `*` and "Not released" in the document
 * status unless text sets it (ADR-090 Q3).
 */
export function resolveTitleBlock(
  layout: Pick<TemplateLayout, 'titleBlock'>,
  data: TitleBlockData,
  fields: { sheet?: TitleBlockFields; drawing?: TitleBlockFields; project?: TitleBlockFields },
): TitleBlockResolution {
  const cascade = (slot: TitleBlockSlot): string | undefined =>
    fields.sheet?.[slot] ?? fields.drawing?.[slot] ?? fields.project?.[slot];
  const slots = new Map<TitleBlockSlot, ResolvedSlot>();
  const present = new Set(layout.titleBlock.cells.map((c) => c.slot));
  for (const slot of present) {
    const text = cascade(slot);
    const bound = boundSlotText(slot, data);
    let r: ResolvedSlot;
    if (text !== undefined && bound !== undefined) r = { slot, text, source: 'override', bound };
    else if (text !== undefined) r = { slot, text, source: 'text' };
    else if (bound !== undefined)
      r = { slot, text: bound, source: bound === '' ? 'empty' : 'bound' };
    else if (slot === 'documentStatus' && data.revision?.released !== true)
      r = { slot, text: 'Not released', source: 'bound' };
    else r = { slot, text: '', source: 'empty' };
    if (slot === 'projection' && r.source === 'bound')
      r.symbol = data.projection === 'first' ? 'projectionFirst' : 'projectionThird';
    if (slot === 'partNumber' && r.text.length > 16)
      r.warnings = ['ISO 7200: the identification number is longer than 16 characters'];
    slots.set(slot, r);
  }
  const unused: TitleBlockResolution['unused'] = [];
  const seen = new Set<TitleBlockSlot>();
  for (const f of [fields.sheet, fields.drawing, fields.project]) {
    for (const [k, v] of Object.entries(f ?? {})) {
      const slot = k as TitleBlockSlot;
      if (v === undefined || present.has(slot) || seen.has(slot)) continue;
      seen.add(slot);
      unused.push({ slot, text: cascade(slot) ?? v });
    }
  }
  unused.sort((a, b) => a.slot.localeCompare(b.slot));
  return { slots, unused };
}

/** Text that fits: the nominal height, shrunk (to 60 % at most) for long values; `overflow` beyond. */
function fitHeight(text: string, nominal: number, room: number): { h: number; overflow: boolean } {
  const w = textWidth(text, nominal);
  if (w <= room) return { h: nominal, overflow: false };
  const h = Math.max(nominal * 0.6, (nominal * room) / w);
  return { h, overflow: textWidth(text, h) > room + 1e-9 };
}

/** Title block display items: grid, captions, values (projection as its symbol). */
export function titleBlockItems(
  layout: Pick<TemplateLayout, 'titleBlock'>,
  resolved: TitleBlockResolution,
): { items: DisplayItem[]; overflow: TitleBlockSlot[] } {
  const items: DisplayItem[] = [];
  const overflow: TitleBlockSlot[] = [];
  const captionH = 1.8;
  for (const cell of layout.titleBlock.cells) {
    const { min, max } = cell.box;
    const source = { kind: 'titleBlock' as const, slot: cell.slot };
    items.push({
      kind: 'text',
      at: [min[0] + 1, max[1] - 1],
      text: normalizeText(cell.caption),
      height: captionH,
      angle: 0,
      align: 'left',
      baseline: 'top',
      role: 'text',
      source,
    });
    const r = resolved.slots.get(cell.slot);
    if (!r) continue;
    const room = max[0] - min[0] - 2;
    const valueTop = max[1] - 1 - captionH - 1;
    if (r.symbol) {
      const g = symbolGlyph(r.symbol);
      const h = Math.min(cell.valueHeight, (valueTop - min[1] - 1) / 2, room / g.advance);
      const w = g.advance * h;
      const at: Vec2 = [(min[0] + max[0] - w) / 2, min[1] + (valueTop - min[1] - 2 * h) / 2];
      for (const p of placeSymbol(r.symbol, at, h)) items.push({ ...p, role: 'thin', source });
      continue;
    }
    if (!r.text) continue;
    const lines = r.text.split('\n');
    const lh = cell.valueHeight * 1.5;
    lines.forEach((line, i) => {
      const s = normalizeText(line);
      const fit = fitHeight(s, cell.valueHeight, room);
      if (fit.overflow && !overflow.includes(cell.slot)) overflow.push(cell.slot);
      const y = Math.min(valueTop - fit.h, min[1] + (valueTop - min[1] - fit.h) / 2) - i * lh;
      items.push({
        kind: 'text',
        at: [min[0] + 1, Math.max(min[1] + 0.8, y)],
        text: s,
        height: fit.h,
        angle: 0,
        align: 'left',
        baseline: 'baseline',
        role: 'text',
        source,
      });
    });
  }
  return { items, overflow };
}
