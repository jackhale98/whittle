// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Compiles high-level `Command`s into RFC 6902 patches against the current document.
 *
 * Rollback-bar rules (`Part.rollbackIndex` = number of leading features that are evaluated):
 *  - addFeature without an index inserts *at the bar* and the bar moves past it (the new feature
 *    is evaluated; features after the bar stay rolled back). With the bar at the end this is
 *    simply "append". An explicit index at or before the bar behaves the same way; an index
 *    after the bar inserts into the rolled-back region and leaves the bar alone.
 *  - removeFeature before the bar moves the bar back by one.
 *  - moveFeature keeps every *other* feature's evaluated/rolled-back state; the moved feature is
 *    evaluated iff it lands before the bar.
 */

import type { Command, Feature, JsonPatchOp, Param, Part, WhittleDoc } from '@whittle/contracts';
import { validateParamName } from './expressions';
import { exprFields, featureReferences } from './features';
import { identifierSpans } from './parser';
import { diff, getAt } from './patch';

export type Compiled =
  | { ok: true; ops: JsonPatchOp[]; label: string }
  | { ok: false; error: string };

const err = (error: string): Compiled => ({ ok: false, error });

function partIndex(doc: WhittleDoc, partId: string): number {
  return doc.parts.findIndex((p) => p.id === partId);
}

function usedIds(doc: WhittleDoc): Set<string> {
  const ids = new Set<string>();
  for (const p of doc.params) ids.add(p.id);
  for (const p of doc.parts) {
    ids.add(p.id);
    for (const f of p.features) ids.add(f.id);
  }
  for (const a of doc.assemblies) ids.add(a.id);
  for (const d of doc.drawings) ids.add(d.id);
  return ids;
}

function findFeature(part: Part, featureId: string): number {
  return part.features.findIndex((f) => f.id === featureId);
}

/** Replaces identifier tokens `from` → `to` in an expression (not function names). */
export function renameInExpr(expr: string, from: string, to: string): string {
  let out = expr;
  try {
    const spans = identifierSpans(expr)
      .filter((s) => s.name === from && !s.call)
      .reverse();
    for (const s of spans) out = out.slice(0, s.span[0]) + to + out.slice(s.span[1]);
  } catch {
    // Unparseable expressions are left alone.
  }
  return out;
}

export function compileCommand(doc: WhittleDoc, cmd: Command): Compiled {
  switch (cmd.kind) {
    case 'addPart': {
      const part = structuredClone(cmd.part);
      if (usedIds(doc).has(part.id)) return err(`The id ‘${part.id}’ is already in use`);
      if (part.rollbackIndex < 0 || part.rollbackIndex > part.features.length) {
        return err('The part’s rollback position is outside its features');
      }
      return {
        ok: true,
        label: `Add ${part.name}`,
        ops: [{ op: 'add', path: '/parts/-', value: part }],
      };
    }
    case 'renamePart': {
      const i = partIndex(doc, cmd.partId);
      if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
      return {
        ok: true,
        label: `Rename ${(doc.parts[i] as Part).name}`,
        ops: [{ op: 'replace', path: `/parts/${i}/name`, value: cmd.name }],
      };
    }
    case 'setMaterial': {
      const i = partIndex(doc, cmd.partId);
      if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
      const part = doc.parts[i] as Part;
      if (cmd.material === null) {
        return part.material === undefined
          ? { ok: true, label: 'Clear material', ops: [] }
          : {
              ok: true,
              label: 'Clear material',
              ops: [{ op: 'remove', path: `/parts/${i}/material` }],
            };
      }
      return {
        ok: true,
        label: `Set material ${cmd.material.name}`,
        ops: [{ op: 'add', path: `/parts/${i}/material`, value: cmd.material }],
      };
    }
    case 'addFeature': {
      const i = partIndex(doc, cmd.partId);
      if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
      const part = doc.parts[i] as Part;
      if (usedIds(doc).has(cmd.feature.id))
        return err(`The id ‘${cmd.feature.id}’ is already in use`);
      const n = part.features.length;
      const bar = part.rollbackIndex;
      const at = cmd.index ?? bar;
      if (!Number.isInteger(at) || at < 0 || at > n) {
        return err(`Cannot insert a feature at position ${at} (the part has ${n})`);
      }
      const ops: JsonPatchOp[] = [
        { op: 'add', path: `/parts/${i}/features/${at}`, value: cmd.feature },
      ];
      if (at <= bar) ops.push({ op: 'replace', path: `/parts/${i}/rollbackIndex`, value: bar + 1 });
      return { ok: true, label: `Add ${cmd.feature.name}`, ops };
    }
    case 'updateFeature': {
      const i = partIndex(doc, cmd.partId);
      if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
      const part = doc.parts[i] as Part;
      const j = findFeature(part, cmd.featureId);
      if (j < 0) return err(`Feature ‘${cmd.featureId}’ was not found`);
      if (cmd.feature.id !== cmd.featureId) return err('A feature’s id cannot be changed');
      const old = part.features[j] as Feature;
      return {
        ok: true,
        label: `Edit ${cmd.feature.name}`,
        ops: diff(old, cmd.feature, `/parts/${i}/features/${j}`),
      };
    }
    case 'removeFeature': {
      const i = partIndex(doc, cmd.partId);
      if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
      const part = doc.parts[i] as Part;
      const j = findFeature(part, cmd.featureId);
      if (j < 0) return err(`Feature ‘${cmd.featureId}’ was not found`);
      const ops: JsonPatchOp[] = [{ op: 'remove', path: `/parts/${i}/features/${j}` }];
      if (j < part.rollbackIndex) {
        ops.push({
          op: 'replace',
          path: `/parts/${i}/rollbackIndex`,
          value: part.rollbackIndex - 1,
        });
      }
      return { ok: true, label: `Delete ${(part.features[j] as Feature).name}`, ops };
    }
    case 'moveFeature': {
      const i = partIndex(doc, cmd.partId);
      if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
      const part = doc.parts[i] as Part;
      const from = findFeature(part, cmd.featureId);
      if (from < 0) return err(`Feature ‘${cmd.featureId}’ was not found`);
      const n = part.features.length;
      const to = cmd.toIndex;
      if (!Number.isInteger(to) || to < 0 || to >= n) {
        return err(`Cannot move to position ${to} (the part has ${n} features)`);
      }
      const moved = part.features[from] as Feature;
      if (from === to) return { ok: true, label: `Move ${moved.name}`, ops: [] };
      const order = part.features.slice();
      order.splice(from, 1);
      order.splice(to, 0, moved);
      for (let k = 0; k < order.length; k++) {
        const other = order[k] as Feature;
        if (other.id === moved.id) continue;
        if (k > to && featureReferences(moved, other.id)) {
          return err(
            `Can’t move ‘${moved.name}’ above ‘${other.name}’ — it uses geometry from ‘${other.name}’.`,
          );
        }
        if (k < to && featureReferences(other, moved.id)) {
          return err(
            `Can’t move ‘${moved.name}’ below ‘${other.name}’ — ‘${other.name}’ uses geometry from ‘${moved.name}’.`,
          );
        }
      }
      const bar = part.rollbackIndex;
      const activeOthers = bar - (from < bar ? 1 : 0);
      const newBar = to <= activeOthers ? activeOthers + 1 : activeOthers;
      const ops: JsonPatchOp[] = [
        { op: 'move', from: `/parts/${i}/features/${from}`, path: `/parts/${i}/features/${to}` },
      ];
      if (newBar !== bar)
        ops.push({ op: 'replace', path: `/parts/${i}/rollbackIndex`, value: newBar });
      return { ok: true, label: `Move ${moved.name}`, ops };
    }
    case 'setSuppressed': {
      const i = partIndex(doc, cmd.partId);
      if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
      const part = doc.parts[i] as Part;
      const j = findFeature(part, cmd.featureId);
      if (j < 0) return err(`Feature ‘${cmd.featureId}’ was not found`);
      const f = part.features[j] as Feature;
      return {
        ok: true,
        label: `${cmd.suppressed ? 'Suppress' : 'Unsuppress'} ${f.name}`,
        ops:
          f.suppressed === cmd.suppressed
            ? []
            : [
                {
                  op: 'replace',
                  path: `/parts/${i}/features/${j}/suppressed`,
                  value: cmd.suppressed,
                },
              ],
      };
    }
    case 'setRollback': {
      const i = partIndex(doc, cmd.partId);
      if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
      const part = doc.parts[i] as Part;
      if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index > part.features.length) {
        return err(`The rollback position must be between 0 and ${part.features.length}`);
      }
      return {
        ok: true,
        label: 'Move rollback bar',
        ops:
          cmd.index === part.rollbackIndex
            ? []
            : [{ op: 'replace', path: `/parts/${i}/rollbackIndex`, value: cmd.index }],
      };
    }
    case 'addParam': {
      const p: Param = structuredClone(cmd.param);
      const bad = validateParamName(p.name);
      if (bad) return err(bad);
      if (doc.params.some((x) => x.name === p.name))
        return err(`A parameter named ‘${p.name}’ already exists`);
      if (usedIds(doc).has(p.id)) return err(`The id ‘${p.id}’ is already in use`);
      return {
        ok: true,
        label: `Add parameter ${p.name}`,
        ops: [{ op: 'add', path: '/params/-', value: p }],
      };
    }
    case 'updateParam':
      return compileUpdateParam(doc, cmd);
    case 'removeParam': {
      const i = doc.params.findIndex((p) => p.id === cmd.paramId);
      if (i < 0) return err(`Parameter ‘${cmd.paramId}’ was not found`);
      return {
        ok: true,
        label: `Delete parameter ${(doc.params[i] as Param).name}`,
        ops: [{ op: 'remove', path: `/params/${i}` }],
      };
    }
    case 'setDocName':
      return {
        ok: true,
        label: 'Rename document',
        ops: [{ op: 'replace', path: '/meta/name', value: cmd.name }],
      };
    case 'patch':
      return { ok: true, label: 'Edit', ops: structuredClone(cmd.ops) };
  }
}

function compileUpdateParam(
  doc: WhittleDoc,
  cmd: Extract<Command, { kind: 'updateParam' }>,
): Compiled {
  const i = doc.params.findIndex((p) => p.id === cmd.paramId);
  if (i < 0) return err(`Parameter ‘${cmd.paramId}’ was not found`);
  const old = doc.params[i] as Param;
  const ops: JsonPatchOp[] = [];
  if (cmd.name !== undefined && cmd.name !== old.name) {
    const bad = validateParamName(cmd.name);
    if (bad) return err(bad);
    if (doc.params.some((x) => x.name === cmd.name)) {
      return err(`A parameter named ‘${cmd.name}’ already exists`);
    }
    ops.push({ op: 'replace', path: `/params/${i}/name`, value: cmd.name });
    // Rename refactor: references in other parameters and in every feature follow the new name.
    doc.params.forEach((p, k) => {
      if (k === i) return;
      const e = renameInExpr(p.expr, old.name, cmd.name as string);
      if (e !== p.expr) ops.push({ op: 'replace', path: `/params/${k}/expr`, value: e });
    });
    // A self-reference (already an error) follows the rename so the message stays accurate.
    if (cmd.expr === undefined) {
      const own = renameInExpr(old.expr, old.name, cmd.name);
      if (own !== old.expr) ops.push({ op: 'replace', path: `/params/${i}/expr`, value: own });
    }
    doc.parts.forEach((part, pi) => {
      part.features.forEach((f, fi) => {
        for (const field of exprFields(f)) {
          const cur = getAt(f, field.pointer);
          if (typeof cur !== 'string') continue;
          const e = renameInExpr(cur, old.name, cmd.name as string);
          if (e !== cur) {
            ops.push({
              op: 'replace',
              path: `/parts/${pi}/features/${fi}${field.pointer}`,
              value: e,
            });
          }
        }
      });
    });
  }
  if (cmd.expr !== undefined && cmd.expr !== old.expr) {
    ops.push({ op: 'replace', path: `/params/${i}/expr`, value: cmd.expr });
  }
  if (cmd.description !== undefined && cmd.description !== (old.description ?? '')) {
    ops.push(
      cmd.description === ''
        ? { op: 'remove', path: `/params/${i}/description` }
        : { op: 'add', path: `/params/${i}/description`, value: cmd.description },
    );
  }
  return {
    ok: true,
    label:
      cmd.name !== undefined && cmd.name !== old.name
        ? `Rename ${old.name} to ${cmd.name}`
        : `Edit ${old.name}`,
    ops,
  };
}
