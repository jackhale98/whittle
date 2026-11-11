/**
 * References that changed meaning (PLAN M3.8, ADR-078/085): the regen reports refs resolved through
 * a face-merge alias (`FeatureStatus.merged`) and refs whose entity grew (`FeatureStatus.grown`).
 * Neither blocks the regen. The UI shows a quiet badge with Accept and Re-pick.
 *
 * Accept is remembered here, per document, on this device: the note for that ref is hidden until
 * what it reports changes again (a different surviving name, or a different size). A document
 * field would sync it between devices; that is a contract proposal (ADR-085), not done here.
 */

import type { FeatureStatus, GrownRef, MergedRef } from '@wren-cad/contracts';
import { observable } from './observable';

const KEY = 'wren.refAcks.v1';

type AckMap = Record<string, Record<string, string>>;

function load(): AckMap {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AckMap) : {};
  } catch {
    return {};
  }
}

const noteId = (featureId: string, kind: 'merged' | 'grown', path: string, name: string) =>
  `${featureId}|${kind}|${path}|${name}`;

/** The value an acknowledgement is bound to: it clears while this is unchanged. */
const mergedValue = (r: MergedRef) => r.into;
const grownValue = (r: GrownRef) => `${Math.round(r.now * 10) / 10}`;

/** Test-only overlay: statuses added as if the kernel reported them (UI states a model can't reach). */
export type StubNotes = { merged?: MergedRef[]; grown?: GrownRef[] };

class RefAcks {
  private acks: AckMap = load();
  private stubs = new Map<string, StubNotes>();
  /** Bumps on every change, so React re-renders what is filtered through `apply`. */
  readonly version = observable(0);

  accept(docId: string, featureId: string, kind: 'merged' | 'grown', ref: MergedRef | GrownRef) {
    const value = kind === 'merged' ? mergedValue(ref as MergedRef) : grownValue(ref as GrownRef);
    const doc = { ...(this.acks[docId] ?? {}) };
    doc[noteId(featureId, kind, ref.path, ref.name)] = value;
    this.acks = { ...this.acks, [docId]: doc };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.acks));
    } catch {}
    this.version.set((v) => v + 1);
  }

  stub(featureId: string, notes: StubNotes | null): void {
    if (notes) this.stubs.set(featureId, notes);
    else this.stubs.delete(featureId);
    this.version.set((v) => v + 1);
  }

  /** The statuses with stubbed notes added and acknowledged notes removed. */
  apply(
    docId: string,
    statuses: readonly FeatureStatus[] | undefined,
  ): readonly FeatureStatus[] | undefined {
    if (!statuses) return statuses;
    const acks = this.acks[docId] ?? {};
    if (this.stubs.size === 0 && Object.keys(acks).length === 0) return statuses;
    return statuses.map((s) => {
      const stub = this.stubs.get(s.featureId);
      const merged = [...(s.merged ?? []), ...(stub?.merged ?? [])].filter(
        (r) => acks[noteId(s.featureId, 'merged', r.path, r.name)] !== mergedValue(r),
      );
      const grown = [...(s.grown ?? []), ...(stub?.grown ?? [])].filter(
        (r) => acks[noteId(s.featureId, 'grown', r.path, r.name)] !== grownValue(r),
      );
      if (merged.length === (s.merged?.length ?? 0) && grown.length === (s.grown?.length ?? 0))
        return s;
      const { merged: _m, grown: _g, ...rest } = s;
      return {
        ...rest,
        ...(merged.length ? { merged } : {}),
        ...(grown.length ? { grown } : {}),
      };
    });
  }
}

export const refAcks = new RefAcks();
