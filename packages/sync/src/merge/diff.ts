// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Feature-level diff between two documents (the compare panel and the merge preview), walking
 * the same id-keyed tree as the merge (`tree.ts`). Each change has a one-line summary:
 * "Fillet 3: radius 2 mm → 3 mm", "Added Hole 2", "Sketch 1: Length (Line 1) 40 mm → 45 mm",
 * "Moved Fillet 2 after Extrude 3". Sketch geometry changes are summarised per sketch (a solve
 * moves many points), while sketch dimension edits are listed one by one. Feature tree folders
 * (M3.6) get their own lines: "Added folder Mounting with Extrude 2 and Fillet 3", "Renamed
 * folder Mounting → Mounts", "Folder Mounting: added Chamfer 4", "Moved folder Mounting after
 * Plane 5"; a sketch's visibility reads "Sketch 1: visibility automatic → shown".
 */

import type {
  DiffChange,
  DiffSubject,
  DocDiffer,
  Feature,
  FeatureFolder,
  FieldChange,
  NamedDimension,
  Param,
  Part,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { isDimension } from '@wren-cad/contracts';
import { Namer } from '@wren-cad/sketch';
import { visibilityOf } from './folders';
import { featureDims, formatValue, listText, plural, type Units } from './format';
import { constraintText, fieldLabel, subjectAt, visibilityText } from './labels';
import { barIdOf, byId, equal, idsOf, isAtomicObject, isObj, type Segs, toPointer } from './tree';

/** Ids of `after` that changed place relative to the others (complement of a longest kept run). */
export function movedIds(before: readonly string[], after: readonly string[]): Set<string> {
  const pos = new Map(before.map((id, i) => [id, i]));
  const seq = after.filter((id) => pos.has(id));
  // Longest increasing subsequence of before-positions (patience sorting, O(n log n)).
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const p = pos.get(seq[i] as string) as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pos.get(seq[tails[mid] as number] as string) as number) < p) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const keep = new Set<string>();
  for (
    let i = tails.length ? (tails[tails.length - 1] as number) : -1;
    i >= 0;
    i = prev[i] as number
  ) {
    keep.add(seq[i] as string);
  }
  return new Set(seq.filter((id) => !keep.has(id)));
}

function fields(
  abs: Segs,
  rel: Segs,
  before: unknown,
  after: unknown,
  skip: ReadonlySet<string>,
  out: FieldChange[],
): void {
  if (equal(before, after)) return;
  if (isObj(before) && isObj(after) && !isAtomicObject(abs, before, after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of [...keys].sort()) {
      if (rel.length === 0 && skip.has(k)) continue;
      fields([...abs, k], [...rel, k], before[k], after[k], skip, out);
    }
    return;
  }
  const fc: FieldChange = { path: toPointer(rel), label: fieldLabel(rel) };
  if (before !== undefined) fc.before = structuredClone(before);
  if (after !== undefined) fc.after = structuredClone(after);
  out.push(fc);
}

function fieldText(fc: FieldChange, units: Units, dims?: Map<string, NamedDimension>): string {
  const dim = dims?.get(fc.path);
  const b = formatValue(fc.before, units, dim);
  const a = formatValue(fc.after, units, dim);
  if (fc.before === undefined) return a === null ? `${fc.label} added` : `${fc.label} set to ${a}`;
  if (fc.after === undefined) return `${fc.label} removed`;
  if (a !== null && b !== null) return `${fc.label} ${b} → ${a}`;
  if (Array.isArray(fc.before) && Array.isArray(fc.after) && fc.before.length !== fc.after.length) {
    return `${fc.label} changed (${fc.before.length} → ${fc.after.length})`;
  }
  return `${fc.label} changed`;
}

class DiffRun {
  readonly out: DiffChange[] = [];
  constructor(
    private readonly before: WrenDoc,
    private readonly after: WrenDoc,
  ) {}

  private subject(segs: Segs, gone = false): DiffSubject {
    return subjectAt(segs, gone ? [this.before, this.after] : [this.after, this.before]);
  }

  private push(change: DiffChange): void {
    this.out.push(change);
  }

  run(): DiffChange[] {
    this.doc();
    this.params();
    this.parts();
    this.simple('drawings', 'drawing');
    this.simple('assemblies', 'assembly');
    return this.out;
  }

  private doc(): void {
    const { before: b, after: a } = this;
    if (b.meta.name !== a.meta.name) {
      this.push({
        kind: 'renamed',
        subject: { kind: 'doc', label: 'Document name' },
        fields: [{ path: '/meta/name', label: 'name', before: b.meta.name, after: a.meta.name }],
        summary: `Renamed the document ${b.meta.name} → ${a.meta.name}`,
      });
    }
    const fs: FieldChange[] = [];
    fields(['units'], ['units'], b.units, a.units, new Set(), fs);
    fields(
      ['meta', 'partNumber'],
      ['partNumber'],
      b.meta.partNumber,
      a.meta.partNumber,
      new Set(),
      fs,
    );
    for (const fc of fs) {
      const label = fc.path.startsWith('/units') ? `units (${fc.label})` : 'part number';
      this.push({
        kind: 'modified',
        subject: { kind: 'doc', label: fc.path.startsWith('/units') ? 'Units' : 'Part number' },
        fields: [fc],
        summary: `Document: ${fieldText({ ...fc, label }, a.units)}`,
      });
    }
  }

  private moves(
    segs: Segs,
    before: readonly { id: string; name: string }[],
    after: readonly { id: string; name: string }[],
    label: (x: { name: string }) => string,
  ): Map<string, DiffChange> {
    const out = new Map<string, DiffChange>();
    const ids = idsOf(after);
    const moved = movedIds(idsOf(before), ids);
    for (const id of moved) {
      const i = ids.indexOf(id);
      const item = after[i] as { name: string };
      const prev = i > 0 ? (after[i - 1] as { name: string }) : undefined;
      out.set(id, {
        kind: 'moved',
        subject: this.subject([...segs, id]),
        summary: prev
          ? `Moved ${label(item)} after ${label(prev)}`
          : `Moved ${label(item)} to the top`,
      });
    }
    return out;
  }

  private params(): void {
    const { before, after } = this;
    const bm = byId(before.params);
    const am = byId(after.params);
    const label = (p: { name: string }) => `parameter ${p.name}`;
    const moved = this.moves(['params'], before.params, after.params, label);
    for (const p of after.params) {
      const old = bm.get(p.id) as Param | undefined;
      const segs = ['params', p.id];
      if (!old) {
        this.push({
          kind: 'added',
          subject: this.subject(segs),
          summary: `Added parameter ${p.name} = ${formatValue(p.expr, after.units)}`,
        });
        continue;
      }
      const fs: FieldChange[] = [];
      fields(segs, [], old, p, new Set(['name', 'id']), fs);
      const texts = fs.map((fc) =>
        fc.path === '/expr'
          ? `${formatValue(fc.before, after.units)} → ${formatValue(fc.after, after.units)}`
          : fieldText(fc, after.units),
      );
      if (old.name !== p.name) {
        this.push({
          kind: 'renamed',
          subject: this.subject(segs),
          fields: [{ path: '/name', label: 'name', before: old.name, after: p.name }, ...fs],
          summary: [`Renamed parameter ${old.name} → ${p.name}`, ...texts].join(', '),
        });
      } else if (fs.length > 0) {
        this.push({
          kind: 'modified',
          subject: this.subject(segs),
          fields: fs,
          summary: `Parameter ${p.name}: ${texts.join(', ')}`,
        });
      }
      const m = moved.get(p.id);
      if (m) this.push(m);
    }
    for (const p of before.params) {
      if (am.has(p.id)) continue;
      this.push({
        kind: 'removed',
        subject: this.subject(['params', p.id], true),
        summary: `Removed parameter ${p.name}`,
      });
    }
  }

  private parts(): void {
    const { before, after } = this;
    const bm = byId(before.parts);
    const am = byId(after.parts);
    const moved = this.moves(['parts'], before.parts, after.parts, (p) => `part ${p.name}`);
    for (const part of after.parts) {
      const old = bm.get(part.id) as Part | undefined;
      if (!old) {
        this.push({
          kind: 'added',
          subject: this.subject(['parts', part.id]),
          summary: `Added part ${part.name}`,
        });
        continue;
      }
      this.part(old, part);
      const m = moved.get(part.id);
      if (m) this.push(m);
    }
    for (const part of before.parts) {
      if (am.has(part.id)) continue;
      this.push({
        kind: 'removed',
        subject: this.subject(['parts', part.id], true),
        summary: `Removed part ${part.name}`,
      });
    }
  }

  private part(old: Part, part: Part): void {
    const units = this.after.units;
    const segs = ['parts', part.id];
    if (old.name !== part.name) {
      this.push({
        kind: 'renamed',
        subject: this.subject(segs),
        fields: [{ path: '/name', label: 'name', before: old.name, after: part.name }],
        summary: `Renamed part ${old.name} → ${part.name}`,
      });
    }
    this.material(old, part);
    if (old.color !== part.color) {
      const fc: FieldChange = { path: '/color', label: 'colour' };
      if (old.color !== undefined) fc.before = old.color;
      if (part.color !== undefined) fc.after = part.color;
      this.push({
        kind: 'modified',
        subject: this.subject(segs),
        fields: [fc],
        summary: `${part.name}: ${fieldText(fc, units)}`,
      });
    }
    const bm = byId(old.features);
    const am = byId(part.features);
    const { moved, folderMoves } = this.featureMoves(old, part);
    for (const f of part.features) {
      const prev = bm.get(f.id) as Feature | undefined;
      const fsegs = [...segs, 'features', f.id];
      if (!prev) {
        this.push({ kind: 'added', subject: this.subject(fsegs), summary: `Added ${f.name}` });
      } else {
        this.feature(part, prev, f);
      }
      const m = moved.get(f.id);
      if (m) this.push(m);
    }
    for (const f of old.features) {
      if (am.has(f.id)) continue;
      this.push({
        kind: 'removed',
        subject: this.subject([...segs, 'features', f.id], true),
        summary: `Removed ${f.name}`,
      });
    }
    this.folders(old, part, folderMoves);
    const [bb, ab] = [barIdOf(old), barIdOf(part)];
    if (bb !== ab) {
      const to = ab === null ? undefined : (am.get(ab) as Feature | undefined);
      this.push({
        kind: 'modified',
        subject: this.subject(segs),
        fields: [
          {
            path: '/rollbackIndex',
            label: 'rollback',
            before: old.rollbackIndex,
            after: part.rollbackIndex,
          },
        ],
        summary: to
          ? `${part.name}: rolled back to before ${to.name}`
          : `${part.name}: rolled forward to the end`,
      });
    }
  }

  /**
   * Feature and folder moves. A folder that kept its members is one item in the comparison, so
   * moving it reads as one "Moved folder" line, never one per member (which members a plain
   * comparison would call "moved" depends on ties); moves inside it are compared among its
   * members.
   */
  private featureMoves(
    old: Part,
    part: Part,
  ): { moved: Map<string, DiffChange>; folderMoves: Map<string, DiffChange> } {
    const before = byId(old.folders ?? []);
    const holder = new Map<string, string>();
    const stable = new Map<string, FeatureFolder>();
    for (const f of part.folders ?? []) {
      const prev = before.get(f.id) as FeatureFolder | undefined;
      if (!prev || prev.features.length !== f.features.length) continue;
      if (!f.features.every((x) => prev.features.includes(x))) continue;
      stable.set(f.id, f);
      for (const x of f.features) holder.set(x, f.id);
    }
    const tokens = (features: readonly Feature[]): string[] => {
      const out: string[] = [];
      for (const f of features) {
        const t = holder.get(f.id) ?? f.id;
        if (out[out.length - 1] !== t) out.push(t);
      }
      return out;
    };
    const after = part.features;
    const index = new Map(after.map((f, i) => [f.id, i]));
    const placed = (firstId: string): string => {
      const prev = after[(index.get(firstId) ?? 0) - 1];
      return prev ? `after ${prev.name}` : 'to the top';
    };
    const moved = new Map<string, DiffChange>();
    const featureMove = (id: string): void => {
      const f = after[index.get(id) as number] as Feature;
      moved.set(id, {
        kind: 'moved',
        subject: this.subject(['parts', part.id, 'features', id]),
        summary: `Moved ${f.name} ${placed(id)}`,
      });
    };
    const folderMoves = new Map<string, DiffChange>();
    for (const t of movedIds(tokens(old.features), tokens(after))) {
      const f = stable.get(t);
      if (f === undefined) {
        featureMove(t);
        continue;
      }
      const first = after.find((x) => holder.get(x.id) === t) as Feature;
      folderMoves.set(t, {
        kind: 'moved',
        subject: this.subject(['parts', part.id, 'folders', t]),
        summary: `Moved folder ${f.name} ${placed(first.id)}`,
      });
    }
    for (const fid of stable.keys()) {
      const members = (features: readonly Feature[]) =>
        features.filter((x) => holder.get(x.id) === fid).map((x) => x.id);
      for (const id of movedIds(members(old.features), members(after))) featureMove(id);
    }
    return { moved, folderMoves };
  }

  /** Folder lines: added, removed, renamed, members joining or leaving, moved. */
  private folders(old: Part, part: Part, moves: ReadonlyMap<string, DiffChange>): void {
    const names = new Map<string, string>();
    for (const f of old.features) names.set(f.id, f.name);
    for (const f of part.features) names.set(f.id, f.name);
    const live = new Set(part.features.map((f) => f.id));
    const name = (id: string) => names.get(id) ?? id;
    const bm = byId(old.folders ?? []);
    const am = byId(part.folders ?? []);
    const segs = ['parts', part.id, 'folders'];
    for (const f of part.folders ?? []) {
      const prev = bm.get(f.id) as FeatureFolder | undefined;
      const fsegs = [...segs, f.id];
      if (!prev) {
        this.push({
          kind: 'added',
          subject: this.subject(fsegs),
          fields: [{ path: '/features', label: 'features', after: f.features.slice() }],
          summary: `Added folder ${f.name} with ${listText(f.features.map(name))}`,
        });
        continue;
      }
      const joined = f.features.filter((x) => !prev.features.includes(x));
      // A member that was deleted is already listed as removed: not again here.
      const left = prev.features.filter((x) => !f.features.includes(x) && live.has(x));
      const texts: string[] = [];
      if (joined.length) texts.push(`added ${listText(joined.map(name))}`);
      if (left.length) texts.push(`removed ${listText(left.map(name))}`);
      const fields: FieldChange[] = [];
      if (prev.name !== f.name) {
        fields.push({ path: '/name', label: 'name', before: prev.name, after: f.name });
      }
      if (!equal(prev.features, f.features)) {
        fields.push({
          path: '/features',
          label: 'features',
          before: prev.features.slice(),
          after: f.features.slice(),
        });
      }
      if (prev.name !== f.name) {
        this.push({
          kind: 'renamed',
          subject: this.subject(fsegs),
          fields,
          summary: [`Renamed folder ${prev.name} → ${f.name}`, ...texts].join(', '),
        });
      } else if (texts.length > 0) {
        this.push({
          kind: 'modified',
          subject: this.subject(fsegs),
          fields,
          summary: `Folder ${f.name}: ${texts.join('; ')}`,
        });
      }
      const m = moves.get(f.id);
      if (m) this.push(m);
    }
    for (const f of old.folders ?? []) {
      if (am.has(f.id)) continue;
      this.push({
        kind: 'removed',
        subject: this.subject([...segs, f.id], true),
        summary: `Removed folder ${f.name}`,
      });
    }
  }

  private material(old: Part, part: Part): void {
    const a = part.material;
    const b = old.material;
    if (equal(a, b)) return;
    const subject: DiffSubject = this.subject(['parts', part.id, 'material']);
    const units = this.after.units;
    if (!b || !a || isAtomicObject(['parts', part.id, 'material'], b, a)) {
      const fc: FieldChange = { path: '/material', label: 'material' };
      if (b) fc.before = structuredClone(b);
      if (a) fc.after = structuredClone(a);
      const summary = !b
        ? `${part.name}: material set to ${a?.name}`
        : !a
          ? `${part.name}: material removed`
          : `${part.name}: material ${b.name} → ${a.name}`;
      this.push({ kind: 'modified', subject, fields: [fc], summary });
      return;
    }
    const fs: FieldChange[] = [];
    fields(['parts', part.id, 'material'], [], b, a, new Set(), fs);
    this.push({
      kind: 'modified',
      subject,
      fields: fs,
      summary: `${part.name}: ${fs.map((fc) => fieldText(fc, units)).join(', ')}`,
    });
  }

  private feature(part: Part, prev: Feature, f: Feature): void {
    const units = this.after.units;
    const segs = ['parts', part.id, 'features', f.id];
    const subject = this.subject(segs);
    const fs: FieldChange[] = [];
    if (prev.type !== f.type) {
      fs.push({ path: '/type', label: 'type', before: prev.type, after: f.type });
    } else {
      const skip = new Set(['id', 'name', 'suppressed', 'entities', 'constraints', 'visibility']);
      fields(segs, [], prev, f, skip, fs);
    }
    const dims = new Map([...featureDims(prev), ...featureDims(f)]);
    const texts = fs.map((fc) => fieldText(fc, units, dims));
    // Sketch visibility: absent and 'auto' are the same, so only a change of meaning is a line.
    if (prev.type === 'sketch' && f.type === 'sketch') {
      const [vb, va] = [visibilityOf(prev.visibility), visibilityOf(f.visibility)];
      if (vb !== va) {
        fs.push({ path: '/visibility', label: 'visibility', before: vb, after: va });
        texts.push(`visibility ${visibilityText(vb)} → ${visibilityText(va)}`);
      }
    }
    const suppression =
      prev.suppressed === f.suppressed ? null : f.suppressed ? 'suppressed' : 'unsuppressed';
    const all = fs.slice();
    if (suppression) {
      all.push({
        path: '/suppressed',
        label: 'suppressed',
        before: prev.suppressed,
        after: f.suppressed,
      });
    }
    if (prev.name !== f.name) {
      all.unshift({ path: '/name', label: 'name', before: prev.name, after: f.name });
      this.push({
        kind: 'renamed',
        subject,
        fields: all,
        summary: [
          `Renamed ${prev.name} → ${f.name}`,
          ...texts,
          ...(suppression ? [suppression] : []),
        ].join(', '),
      });
    } else if (texts.length === 0 && suppression) {
      this.push({
        kind: 'modified',
        subject,
        fields: all,
        summary: `${suppression === 'suppressed' ? 'Suppressed' : 'Unsuppressed'} ${f.name}`,
      });
    } else if (texts.length > 0) {
      this.push({
        kind: 'modified',
        subject,
        fields: all,
        summary: `${f.name}: ${[...texts, ...(suppression ? [suppression] : [])].join(', ')}`,
      });
    }
    if (prev.type === 'sketch' && f.type === 'sketch') this.sketch(part, prev, f);
  }

  private sketch(part: Part, prev: SketchFeature, f: SketchFeature): void {
    const units = this.after.units;
    const segs = ['parts', part.id, 'features', f.id];
    const bc = byId(prev.constraints);
    const ac = byId(f.constraints);
    let changedConstraints = 0;
    for (const c of f.constraints) {
      const p = bc.get(c.id) as SketchConstraint | undefined;
      if (!p || equal(p, c)) continue;
      if (isDimension(c) && isDimension(p) && p.kind === c.kind) {
        const dim: NamedDimension = c.kind === 'angle' ? 'angle' : 'length';
        const text = constraintText(f, c);
        const parts: string[] = [];
        const fs: FieldChange[] = [];
        if (p.value !== c.value) {
          fs.push({ path: '/value', label: 'value', before: p.value, after: c.value });
          parts.push(
            `${text} ${formatValue(p.value, units, dim)} → ${formatValue(c.value, units, dim)}`,
          );
        }
        if (p.driving !== c.driving) {
          fs.push({ path: '/driving', label: 'driving', before: p.driving, after: c.driving });
          parts.push(`${text} is now a ${c.driving ? 'driving' : 'reference'} dimension`);
        }
        if (parts.length > 0) {
          this.push({
            kind: 'modified',
            subject: this.subject([...segs, 'constraints', c.id]),
            fields: fs,
            summary: `${f.name}: ${parts.join(', ')}`,
          });
          continue;
        }
        // Only the label moved: not worth a line.
        if (equal({ ...p, label: undefined }, { ...c, label: undefined })) continue;
      }
      changedConstraints++;
    }
    const be = byId(prev.entities);
    const ae = byId(f.entities);
    const afterNames = new Namer(f.entities);
    const beforeNames = new Namer(prev.entities);
    const added = f.entities.filter((e) => !be.has(e.id)).map((e) => afterNames.entity(e.id));
    const removed = prev.entities.filter((e) => !ae.has(e.id)).map((e) => beforeNames.entity(e.id));
    const changed = f.entities.filter((e) => {
      const p = be.get(e.id) as SketchEntity | undefined;
      return p !== undefined && !equal(p, e);
    }).length;
    const addedC = f.constraints.filter((c) => !bc.has(c.id)).length;
    const removedC = prev.constraints.filter((c) => !ac.has(c.id)).length;
    const parts: string[] = [];
    if (added.length) parts.push(`added ${listText(added)}`);
    if (removed.length) parts.push(`removed ${listText(removed)}`);
    if (changed) parts.push(`changed ${plural(changed, 'entity', 'entities')}`);
    if (addedC) parts.push(`added ${plural(addedC, 'constraint')}`);
    if (removedC) parts.push(`removed ${plural(removedC, 'constraint')}`);
    if (changedConstraints) parts.push(`changed ${plural(changedConstraints, 'constraint')}`);
    if (parts.length === 0) return;
    this.push({
      kind: 'modified',
      subject: this.subject(segs),
      summary: `${f.name}: ${parts.join('; ')}`,
    });
  }

  private simple(key: 'drawings' | 'assemblies', noun: string): void {
    const bm = byId(this.before[key]);
    const am = byId(this.after[key]);
    for (const x of this.after[key]) {
      const old = bm.get(x.id) as { name: string } | undefined;
      if (!old) {
        this.push({
          kind: 'added',
          subject: this.subject([key, x.id]),
          summary: `Added ${noun} ${x.name}`,
        });
      } else if (old.name !== x.name) {
        this.push({
          kind: 'renamed',
          subject: this.subject([key, x.id]),
          fields: [{ path: '/name', label: 'name', before: old.name, after: x.name }],
          summary: `Renamed ${noun} ${old.name} → ${x.name}`,
        });
      }
    }
    for (const x of this.before[key]) {
      if (!am.has(x.id)) {
        this.push({
          kind: 'removed',
          subject: this.subject([key, x.id], true),
          summary: `Removed ${noun} ${x.name}`,
        });
      }
    }
  }
}

export class FeatureDiffer implements DocDiffer {
  diff(before: WrenDoc, after: WrenDoc): DiffChange[] {
    return new DiffRun(before, after).run();
  }
}

export const docDiffer: DocDiffer = new FeatureDiffer();
