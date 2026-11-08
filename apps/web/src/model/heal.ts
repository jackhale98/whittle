/**
 * Reference healing (PLAN §7.3). The regen engine resolves a stale reference by name family or
 * fingerprint and reports its current name in `FeatureStatus.rebound`. The app writes those names
 * back so stored references stay current.
 *
 * Choice (ADR-008): healing is **folded into the next user edit** — the renames ride in the same
 * undo step as whatever the user does next — instead of being a separate history entry. A
 * standalone housekeeping entry would make the first undo a no-op from the user's point of view,
 * and the store has no history-free patch. Until the next edit nothing is lost: the engine keeps
 * rebinding by fingerprint on every regen.
 */

import type { Command, Feature, FeatureStatus, Id, JsonPatchOp, Part } from '@whittle/contracts';

export type Heal = { path: string; name: string };
export type Heals = ReadonlyMap<Id, readonly Heal[]>;

/** Rebound names from a regen of the current document (features that resolved by fingerprint). */
export function healsFrom(statuses: readonly FeatureStatus[]): Map<Id, Heal[]> {
  const out = new Map<Id, Heal[]>();
  for (const s of statuses) if (s.rebound?.length) out.set(s.featureId, [...s.rebound]);
  return out;
}

/** The value at a JSON pointer inside a feature. */
function at(f: unknown, path: string): unknown {
  let cur = f;
  for (const seg of path.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const isRef = (v: unknown): v is { name: string } =>
  !!v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string';

/** A copy of `feature` with healed reference names (the same object when nothing applies). */
export function healFeature<F extends Feature>(feature: F, heals: readonly Heal[]): F {
  const todo = heals.filter((h) => {
    const r = at(feature, h.path);
    return isRef(r) && r.name !== h.name;
  });
  if (!todo.length) return feature;
  const copy = structuredClone(feature);
  for (const h of todo) (at(copy, h.path) as { name: string }).name = h.name;
  return copy;
}

/** Patch ops renaming stale refs of `part` (at `partIndex`), skipping feature `except`. */
export function healOps(part: Part, partIndex: number, heals: Heals, except?: Id): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  part.features.forEach((f, i) => {
    if (f.id === except) return;
    for (const h of heals.get(f.id) ?? []) {
      const r = at(f, h.path);
      if (isRef(r) && r.name !== h.name)
        ops.push({
          op: 'replace',
          path: `/parts/${partIndex}/features/${i}${h.path}/name`,
          value: h.name,
        });
    }
  });
  return ops;
}

export type Compile = (
  c: Command,
) => { ok: true; ops: JsonPatchOp[]; label: string } | { ok: false; error: string };

/**
 * Folds pending heals into a user command: an `updateFeature` of a healed feature gets its refs
 * healed in place; every other healed feature becomes extra `replace` ops in front of the
 * command's own (compiled) ops, as one `patch` command with the command's label.
 */
export function foldHeals(
  command: Command,
  part: Part | undefined,
  heals: Heals,
  compile: Compile,
): { command: Command; label?: string } {
  if (!part || heals.size === 0) return { command };
  let cmd = command;
  let except: Id | undefined;
  if (cmd.kind === 'updateFeature') {
    const h = heals.get(cmd.featureId);
    if (h) cmd = { ...cmd, feature: healFeature(cmd.feature, h) };
    except = cmd.featureId;
  }
  const ops = healOps(part, 0, heals, except);
  if (!ops.length) return { command: cmd };
  const compiled = compile(cmd);
  if (!compiled.ok) return { command: cmd };
  return { command: { kind: 'patch', ops: [...ops, ...compiled.ops] }, label: compiled.label };
}
