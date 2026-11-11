// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Compare lines for part configurations and part properties (M3.7, ADR-074):
 *  - "Added configuration Long", "Removed configuration Long", "Renamed configuration Long →
 *    Long arm", "Moved configuration Long after Short";
 *  - one line per changed override cell, named by configuration and target: "Long: width 40 mm →
 *    45 mm" (setting an override compares it with the inherited Default value), "Long: Fillet 3
 *    suppressed", "Long: Fillet 3 radius 2 mm → 3 mm", "Long: material Aluminium 6061-T6 →
 *    Steel", "Long: width reset to default (40 mm)";
 *  - "Active configuration: Default → Long" (prefixed with the part's name in a multi-part
 *    document: "Bracket: active configuration Default → Long");
 *  - the Default's properties: "Bracket: part number set to BR-100".
 */

import type {
  Configuration,
  DiffChange,
  DiffSubject,
  FieldChange,
  Part,
  WrenDoc,
} from '@wren-cad/contracts';
import { type Cell, cellDefault, cellsOf, cellText, configurationName } from './configurations';
import { movedIds } from './diff';
import { configurationCellTarget, fieldLabel, subjectAt } from './labels';
import { byId, equal, idsOf, toPointer } from './tree';

/** The compare lines for `old` → `part` (the same part in `before` and `after`). */
export function configurationChanges(
  before: WrenDoc,
  after: WrenDoc,
  old: Part,
  part: Part,
): DiffChange[] {
  const out: DiffChange[] = [];
  const pid = part.id;
  const subject = (segs: string[], gone = false): DiffSubject =>
    subjectAt(['parts', pid, ...segs], gone ? [before, after] : [after, before]);

  // The Default's part properties.
  const keys = new Set([
    ...Object.keys(old.properties ?? {}),
    ...Object.keys(part.properties ?? {}),
  ]);
  for (const k of [...keys].sort()) {
    const b = (old.properties as Record<string, unknown> | undefined)?.[k];
    const a = (part.properties as Record<string, unknown> | undefined)?.[k];
    if (equal(a, b)) continue;
    const label = fieldLabel([k]);
    const fc: FieldChange = { path: `/properties/${k}`, label };
    if (b !== undefined) fc.before = b;
    if (a !== undefined) fc.after = a;
    const text =
      b === undefined
        ? `${label} set to ${String(a)}`
        : a === undefined
          ? `${label} removed`
          : `${label} ${String(b)} → ${String(a)}`;
    out.push({
      kind: 'modified',
      subject: subject(['properties', k]),
      fields: [fc],
      summary: `${part.name}: ${text}`,
    });
  }

  const bl = old.configurations ?? [];
  const al = part.configurations ?? [];
  const bm = byId(bl);
  const am = byId(al);
  const moved = movedIds(idsOf(bl), idsOf(al));
  for (const [i, c] of al.entries()) {
    const prev = bm.get(c.id) as Configuration | undefined;
    const csegs = ['configurations', c.id];
    if (!prev) {
      out.push({
        kind: 'added',
        subject: subject(csegs),
        summary: `Added configuration ${c.name}`,
      });
      continue;
    }
    if (prev.name !== c.name) {
      out.push({
        kind: 'renamed',
        subject: subject(csegs),
        fields: [{ path: '/name', label: 'name', before: prev.name, after: c.name }],
        summary: `Renamed configuration ${prev.name} → ${c.name}`,
      });
    }
    out.push(...cellChanges(before, after, old, part, prev, c));
    if (moved.has(c.id)) {
      const after = i > 0 ? al[i - 1] : undefined;
      out.push({
        kind: 'moved',
        subject: subject(csegs),
        summary: after
          ? `Moved configuration ${c.name} after ${after.name}`
          : `Moved configuration ${c.name} to the top`,
      });
    }
  }
  for (const c of bl) {
    if (am.has(c.id)) continue;
    out.push({
      kind: 'removed',
      subject: subject(['configurations', c.id], true),
      summary: `Removed configuration ${c.name}`,
    });
  }

  const [ba, aa] = [old.activeConfigurationId, part.activeConfigurationId];
  if (ba !== aa) {
    const from = configurationName([before, after], pid, ba);
    const to = configurationName([after, before], pid, aa);
    const fc: FieldChange = { path: '/activeConfigurationId', label: 'active configuration' };
    if (ba !== undefined) fc.before = ba;
    if (aa !== undefined) fc.after = aa;
    out.push({
      kind: 'modified',
      subject: subject(['activeConfigurationId']),
      fields: [fc],
      summary:
        after.parts.length > 1
          ? `${part.name}: active configuration ${from} → ${to}`
          : `Active configuration: ${from} → ${to}`,
    });
  }
  return out;
}

const cellKey = (cell: Cell): string => JSON.stringify(cell.rel);

/** One line per override cell that differs between two versions of a configuration. */
function cellChanges(
  before: WrenDoc,
  after: WrenDoc,
  old: Part,
  part: Part,
  prev: Configuration,
  config: Configuration,
): DiffChange[] {
  const out: DiffChange[] = [];
  const bc = new Map(cellsOf(prev).map((c) => [cellKey(c), c]));
  const ac = new Map(cellsOf(config).map((c) => [cellKey(c), c]));
  const keys = [...new Set([...bc.keys(), ...ac.keys()])];
  for (const k of keys) {
    const b = bc.get(k)?.value;
    const a = ac.get(k)?.value;
    if (equal(a, b)) continue;
    const rel = (ac.get(k) ?? bc.get(k))?.rel as string[];
    const segs = ['parts', part.id, 'configurations', config.id, ...rel];
    const docs = a === undefined ? [before, after] : [after, before];
    const s = subjectAt(segs, docs);
    const target = configurationCellTarget(part.id, rel, docs);
    const fc: FieldChange = { path: toPointer(rel), label: target };
    if (b !== undefined) fc.before = structuredClone(b);
    if (a !== undefined) fc.after = structuredClone(a);
    const bText = (v: unknown) => cellText(rel, v, before.units, old, before);
    const aText = (v: unknown) => cellText(rel, v, after.units, part, after);
    let text: string;
    if (rel[0] === 'features' && rel[2] === 'suppressed') {
      const name = configurationCellTarget(part.id, ['features', rel[1] as string], docs);
      if (a === undefined) {
        const d = cellDefault(after, part, rel);
        const def = d.known ? ` (${d.value ? 'suppressed' : 'not suppressed'})` : '';
        text = `${name} suppression reset to default${def}`;
      } else text = `${name} ${a ? 'suppressed' : 'unsuppressed'}`;
    } else if (a === undefined) {
      const d = cellDefault(after, part, rel);
      text = `${target} reset to default${d.known ? ` (${aText(d.value)})` : ''}`;
    } else if (b === undefined) {
      const d = cellDefault(before, old, rel);
      text = d.known ? `${target} ${bText(d.value)} → ${aText(a)}` : `${target} set to ${aText(a)}`;
    } else text = `${target} ${bText(b)} → ${aText(a)}`;
    s.label = `${config.name}: ${target}`;
    out.push({ kind: 'modified', subject: s, fields: [fc], summary: `${config.name}: ${text}` });
  }
  return out;
}
