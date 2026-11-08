/// A small `DocMerger` for engine tests (the real one is sync-engineer B's): three-way merge of
/// `params` and `parts` keyed by id at item granularity, `meta.modified` takes the later.

import type {
  DocMerger,
  MergeConflict,
  MergeResolution,
  MergeResult,
  WhittleDoc,
} from '@whittle/contracts';

type Item = { id: string; name: string };
type Key = 'params' | 'parts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mergeList<T extends Item>(
  key: Key,
  base: T[],
  ours: T[],
  theirs: T[],
  conflicts: MergeConflict[],
): { list: T[]; auto: number } {
  const b = new Map(base.map((x) => [x.id, x]));
  const o = new Map(ours.map((x) => [x.id, x]));
  const t = new Map(theirs.map((x) => [x.id, x]));
  const order = [...ours.map((x) => x.id), ...theirs.map((x) => x.id).filter((id) => !o.has(id))];
  const out: T[] = [];
  let auto = 0;
  for (const id of order) {
    const bx = b.get(id);
    const ox = o.get(id);
    const tx = t.get(id);
    const label = (ox ?? tx ?? bx)?.name ?? id;
    const conflict = (kind: MergeConflict['kind']) =>
      conflicts.push({
        id: `${key}:${id}`,
        kind,
        path: `/${key}/${id}`,
        subject: { kind: key === 'params' ? 'param' : 'part', id, label },
        ...(bx ? { base: bx } : {}),
        ...(ox ? { ours: ox } : {}),
        ...(tx ? { theirs: tx } : {}),
      });
    if (same(ox, tx)) {
      if (ox) out.push(ox);
      continue;
    }
    if (same(bx, ox)) {
      // Only theirs changed.
      auto += 1;
      if (tx) out.push(tx);
      continue;
    }
    if (same(bx, tx)) {
      if (ox) out.push(ox);
      continue;
    }
    // Both changed differently.
    conflict(!bx ? 'bothAdded' : !ox || !tx ? 'modifiedDeleted' : 'bothModified');
    if (ox) out.push(ox);
  }
  return { list: out, auto };
}

export class FakeMerger implements DocMerger {
  calls = 0;
  merge(base: WhittleDoc, ours: WhittleDoc, theirs: WhittleDoc): MergeResult {
    this.calls += 1;
    const conflicts: MergeConflict[] = [];
    const params = mergeList('params', base.params, ours.params, theirs.params, conflicts);
    const parts = mergeList('parts', base.parts, ours.parts, theirs.parts, conflicts);
    // ISO-8601 strings: the later sorts last.
    const modified = [ours.meta.modified, theirs.meta.modified].sort()[1] as string;
    const doc: WhittleDoc = {
      ...ours,
      params: params.list,
      parts: parts.list,
      meta: { ...ours.meta, modified },
    };
    return { doc, conflicts, autoMerged: params.auto + parts.auto };
  }

  resolve(result: MergeResult, resolutions: readonly MergeResolution[]): WhittleDoc {
    const doc = structuredClone(result.doc);
    for (const r of resolutions) {
      const c = result.conflicts.find((x) => x.id === r.conflictId);
      if (!c) continue;
      const [key, id] = c.id.split(':') as [Key, string];
      const value =
        'value' in r
          ? r.value
          : r.take === 'theirs'
            ? c.theirs
            : r.take === 'base'
              ? c.base
              : c.ours;
      const list = doc[key] as Item[];
      const i = list.findIndex((x) => x.id === id);
      if (value === undefined) {
        if (i >= 0) list.splice(i, 1);
      } else if (i >= 0) list[i] = value as Item;
      else list.push(value as Item);
    }
    return doc;
  }
}
