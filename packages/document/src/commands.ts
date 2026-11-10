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

import type {
  Command,
  Feature,
  FeatureFolder,
  Id,
  JsonPatchOp,
  Param,
  Part,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { validateParamName } from './expressions';
import { exprFields, featureReferences } from './features';
import { folderOps, foldersAfterPlace, foldersAfterRemove, normalizeFolders } from './folders';
import { identifierSpans } from './parser';
import { applyPatch, diff, getAt } from './patch';

export type Compiled =
  | { ok: true; ops: JsonPatchOp[]; label: string }
  | { ok: false; error: string };

const err = (error: string): Compiled => ({ ok: false, error });

function partIndex(doc: WrenDoc, partId: string): number {
  return doc.parts.findIndex((p) => p.id === partId);
}

function usedIds(doc: WrenDoc): Set<string> {
  const ids = new Set<string>();
  for (const p of doc.params) ids.add(p.id);
  for (const p of doc.parts) {
    ids.add(p.id);
    for (const f of p.features) ids.add(f.id);
    for (const f of p.folders ?? []) ids.add(f.id);
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

export function compileCommand(doc: WrenDoc, cmd: Command): Compiled {
  switch (cmd.kind) {
    case 'addPart': {
      const part = structuredClone(cmd.part);
      if (usedIds(doc).has(part.id)) return err(`The id ‘${part.id}’ is already in use`);
      if (part.rollbackIndex < 0 || part.rollbackIndex > part.features.length) {
        return err('The part’s rollback position is outside its features');
      }
      const folderIds = new Set<string>();
      for (const f of part.folders ?? []) {
        if (folderIds.has(f.id) || usedIds(doc).has(f.id)) {
          return err(`The id ‘${f.id}’ is already in use`);
        }
        folderIds.add(f.id);
      }
      if (part.folders) {
        const fixed = normalizeFolders(part).part;
        if (fixed.folders) part.folders = fixed.folders;
        else delete part.folders;
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
      if (part.folders) {
        const order = part.features.map((f) => f.id);
        order.splice(at, 0, cmd.feature.id);
        ops.push(
          ...folderOps(i, part.folders, foldersAfterPlace(part.folders, order, cmd.feature.id)),
        );
      }
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
      if (part.folders) {
        ops.push(...folderOps(i, part.folders, foldersAfterRemove(part.folders, cmd.featureId)));
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
      if (part.folders) {
        const ids = order.map((f) => f.id);
        ops.push(...folderOps(i, part.folders, foldersAfterPlace(part.folders, ids, moved.id)));
      }
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
      return compilePatch(doc, cmd.ops);
    case 'setSuppressedMany':
      return compileSuppressMany(doc, cmd);
    case 'setSketchVisibility':
      return compileVisibility(doc, cmd);
    case 'addFolder':
      return compileAddFolder(doc, cmd);
    case 'renameFolder':
    case 'removeFolder':
      return compileRenameOrRemoveFolder(doc, cmd);
    case 'moveFolder':
      return compileMoveFolder(doc, cmd);
  }
}

/**
 * A raw patch may reorder or delete features; folders follow by running the merge normalisation
 * on every part the patch leaves with broken folders (same patch, one undo entry).
 */
function compilePatch(doc: WrenDoc, patchOps: JsonPatchOp[]): Compiled {
  const ops = structuredClone(patchOps);
  try {
    const after = applyPatch(doc, ops).doc;
    after.parts.forEach((part, i) => {
      if (!part.folders) return;
      const fixed = normalizeFolders(part).part;
      if (fixed !== part) ops.push(...folderOps(i, part.folders, fixed.folders ?? []));
    });
  } catch {
    // The store reports the failing patch itself.
  }
  return { ok: true, label: 'Edit', ops };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function compileSuppressMany(
  doc: WrenDoc,
  cmd: Extract<Command, { kind: 'setSuppressedMany' }>,
): Compiled {
  const i = partIndex(doc, cmd.partId);
  if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
  const part = doc.parts[i] as Part;
  const wanted = new Set(cmd.featureIds);
  const ops: JsonPatchOp[] = [];
  let known = 0;
  let name = '';
  part.features.forEach((f, j) => {
    if (!wanted.has(f.id)) return;
    known++;
    if (f.suppressed === cmd.suppressed) return;
    name = f.name;
    ops.push({
      op: 'replace',
      path: `/parts/${i}/features/${j}/suppressed`,
      value: cmd.suppressed,
    });
  });
  const verb = cmd.suppressed ? 'Suppress' : 'Unsuppress';
  const n = ops.length === 0 ? known : ops.length;
  const what = n === 1 && name !== '' ? name : plural(n, 'feature', 'features');
  return { ok: true, label: `${verb} ${what}`, ops };
}

function compileVisibility(
  doc: WrenDoc,
  cmd: Extract<Command, { kind: 'setSketchVisibility' }>,
): Compiled {
  const i = partIndex(doc, cmd.partId);
  if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
  if (!['auto', 'shown', 'hidden'].includes(cmd.visibility)) {
    return err(`‘${String(cmd.visibility)}’ is not a sketch visibility`);
  }
  const part = doc.parts[i] as Part;
  const wanted = new Set(cmd.featureIds);
  const ops: JsonPatchOp[] = [];
  let known = 0;
  let name = '';
  part.features.forEach((f, j) => {
    if (f.type !== 'sketch' || !wanted.has(f.id)) return;
    known++;
    const cur = (f as SketchFeature).visibility;
    if ((cur ?? 'auto') === cmd.visibility) return;
    name = f.name;
    const path = `/parts/${i}/features/${j}/visibility`;
    if (cmd.visibility === 'auto') ops.push({ op: 'remove', path });
    else ops.push({ op: cur === undefined ? 'add' : 'replace', path, value: cmd.visibility });
  });
  const verb =
    cmd.visibility === 'shown'
      ? 'Show'
      : cmd.visibility === 'hidden'
        ? 'Hide'
        : 'Reset visibility of';
  const n = ops.length === 0 ? known : ops.length;
  const what = n === 1 && name !== '' ? name : plural(n, 'sketch', 'sketches');
  return { ok: true, label: `${verb} ${what}`, ops };
}

function compileAddFolder(doc: WrenDoc, cmd: Extract<Command, { kind: 'addFolder' }>): Compiled {
  const i = partIndex(doc, cmd.partId);
  if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
  const part = doc.parts[i] as Part;
  const { id, name } = cmd.folder;
  if (typeof id !== 'string' || id === '') return err('A folder needs an id');
  if (typeof name !== 'string') return err('A folder needs a name');
  if (usedIds(doc).has(id)) return err(`The id ‘${id}’ is already in use`);
  const wanted = cmd.folder.features;
  if (!Array.isArray(wanted) || wanted.length === 0) {
    return err('A folder needs at least one feature');
  }
  const order = part.features.map((f) => f.id);
  const idx: number[] = [];
  for (const m of wanted) {
    const k = order.indexOf(m);
    if (k < 0) return err(`Feature ‘${m}’ was not found, so it cannot go in a folder`);
    if (idx.includes(k)) return err('A feature can only be listed once in a folder');
    idx.push(k);
    const holder = part.folders?.find((f) => f.features.includes(m));
    if (holder) {
      const f = part.features[k] as Feature;
      return err(`‘${f.name}’ is already in the folder ‘${holder.name}’`);
    }
  }
  idx.sort((a, b) => a - b);
  if (idx.some((v, k) => k > 0 && v !== (idx[k - 1] as number) + 1)) {
    return err('A folder can only hold features that follow one another in the tree');
  }
  const folder: FeatureFolder = { id, name, features: idx.map((k) => order[k] as Id) };
  const ops: JsonPatchOp[] = part.folders
    ? [{ op: 'add', path: `/parts/${i}/folders/-`, value: folder }]
    : [{ op: 'add', path: `/parts/${i}/folders`, value: [folder] }];
  return { ok: true, label: `New folder ${name}`, ops };
}

function compileRenameOrRemoveFolder(
  doc: WrenDoc,
  cmd: Extract<Command, { kind: 'renameFolder' | 'removeFolder' }>,
): Compiled {
  const i = partIndex(doc, cmd.partId);
  if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
  const part = doc.parts[i] as Part;
  const k = (part.folders ?? []).findIndex((f) => f.id === cmd.folderId);
  const folder = part.folders?.[k];
  if (!folder) return err(`Folder ‘${cmd.folderId}’ was not found`);
  if (cmd.kind === 'renameFolder') {
    if (typeof cmd.name !== 'string') return err('A folder needs a name');
    return {
      ok: true,
      label: `Rename folder ${folder.name} to ${cmd.name}`,
      ops:
        cmd.name === folder.name
          ? []
          : [{ op: 'replace', path: `/parts/${i}/folders/${k}/name`, value: cmd.name }],
    };
  }
  const rest = (part.folders ?? []).filter((_, n) => n !== k);
  return { ok: true, label: `Remove folder ${folder.name}`, ops: folderOps(i, part.folders, rest) };
}

function compileMoveFolder(doc: WrenDoc, cmd: Extract<Command, { kind: 'moveFolder' }>): Compiled {
  const i = partIndex(doc, cmd.partId);
  if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
  const part = doc.parts[i] as Part;
  const folder = part.folders?.find((f) => f.id === cmd.folderId);
  if (!folder) return err(`Folder ‘${cmd.folderId}’ was not found`);
  const members = new Set(folder.features);
  const run = part.features.filter((f) => members.has(f.id));
  const rest = part.features.filter((f) => !members.has(f.id));
  const to = cmd.toIndex;
  if (!Number.isInteger(to) || to < 0 || to > rest.length) {
    return err(
      `Cannot move the folder to position ${to} (there are ${rest.length} other features)`,
    );
  }
  const label = `Move folder ${folder.name}`;
  if (to === part.features.findIndex((f) => members.has(f.id))) return { ok: true, label, ops: [] };
  // Landing between two members of one other folder would split it.
  const before = rest[to - 1];
  const after = rest[to];
  if (before && after) {
    const host = part.folders?.find(
      (f) => f.id !== folder.id && f.features.includes(before.id) && f.features.includes(after.id),
    );
    if (host) return err(`Can’t move ‘${folder.name}’ into the folder ‘${host.name}’.`);
  }
  const order = [...rest.slice(0, to), ...run, ...rest.slice(to)];
  const at = new Map(order.map((f, n) => [f.id, n]));
  for (const f of run) {
    for (const g of rest) {
      const fi = at.get(f.id) as number;
      const gi = at.get(g.id) as number;
      if (fi < gi && featureReferences(f, g.id)) {
        return err(
          `Can’t move ‘${folder.name}’ above ‘${g.name}’ — ‘${f.name}’ uses geometry from ‘${g.name}’.`,
        );
      }
      if (gi < fi && featureReferences(g, f.id)) {
        return err(
          `Can’t move ‘${folder.name}’ below ‘${g.name}’ — ‘${g.name}’ uses geometry from ‘${f.name}’.`,
        );
      }
    }
  }
  // Rollback bar: the run is evaluated iff it lands before the other features' bar.
  const bar = part.rollbackIndex;
  const activeOthers = part.features.slice(0, bar).filter((f) => !members.has(f.id)).length;
  const newBar = to <= activeOthers ? activeOthers + run.length : activeOthers;
  // One `move` per member, each straight to its final slot: top-down when the run moves up,
  // bottom-up when it moves down, so earlier moves never disturb later targets.
  const first = part.features.findIndex((f) => members.has(f.id));
  const working = part.features.map((f) => f.id);
  const ops: JsonPatchOp[] = [];
  const sequence = to < first ? run.map((_, n) => n) : run.map((_, n) => run.length - 1 - n);
  for (const n of sequence) {
    const id = (run[n] as Feature).id;
    const from = working.indexOf(id);
    const target = to + n;
    if (from === target) continue;
    working.splice(from, 1);
    working.splice(target, 0, id);
    ops.push({
      op: 'move',
      from: `/parts/${i}/features/${from}`,
      path: `/parts/${i}/features/${target}`,
    });
  }
  if (newBar !== bar) ops.push({ op: 'replace', path: `/parts/${i}/rollbackIndex`, value: newBar });
  return { ok: true, label, ops };
}

function compileUpdateParam(
  doc: WrenDoc,
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
