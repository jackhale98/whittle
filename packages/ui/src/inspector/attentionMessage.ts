import type { AttentionCause, EntityKind, Id } from '@wren-cad/contracts';

/**
 * Errors at their cause (ADR-046, research report "errors far from their cause"): the sentence
 * that says which upstream feature broke a reference or a feature. Pure; the cause is only ever
 * what the engine reported in `AttentionCause`, never a guess, and without one there is no
 * sentence (the caller keeps its generic message).
 */

export interface AttentionSentence {
  /** Text before the cause name ("Fillet 2 lost its edge because "). */
  before: string;
  /** The upstream feature. `selectable` is false when it no longer exists (deleted). */
  cause: { featureId: Id; name: string; selectable: boolean };
  /** Text after it (" changed (depth 10 → 4 mm)."). */
  after: string;
  /** The whole sentence as plain text, for screen readers and tooltips. */
  text: string;
}

export interface AttentionInput {
  /** The feature that needs attention, has an error, or is blocked. */
  feature: string;
  state: 'needsAttention' | 'error' | 'blocked';
  /** The unresolved reference this sentence is about (needsAttention). */
  ref?: { kind: EntityKind; reason: 'missing' | 'ambiguous' };
  cause: AttentionCause | undefined;
  /** Name of a feature by id; undefined when it is unknown or gone. */
  nameOf(id: Id): string | undefined;
}

const NOUN: Record<EntityKind, string> = {
  edge: 'edge',
  face: 'face',
  vertex: 'vertex',
  region: 'region',
  body: 'body',
};

const VERB: Record<AttentionCause['kind'], string> = {
  changed: 'changed',
  suppressed: 'is suppressed',
  deleted: 'was deleted',
  reordered: 'now comes after it',
  failed: 'failed',
};

/** `Fillet 2 lost its edge because Extrude 1 changed.`, or null when no cause is known. */
export function attentionSentence(input: AttentionInput): AttentionSentence | null {
  const { feature, state, ref, cause, nameOf } = input;
  if (!cause) return null;
  const known = nameOf(cause.featureId);
  const name = known ?? 'an earlier feature';
  const noun = ref ? NOUN[ref.kind] : 'reference';
  const lead =
    state === 'needsAttention'
      ? ref?.reason === 'ambiguous'
        ? `${feature} now matches more than one ${noun} because `
        : `${feature} lost its ${noun} because `
      : state === 'blocked'
        ? `${feature} is waiting because `
        : `${feature} could not rebuild because `;
  const detail = cause.detail ? ` (${cause.detail})` : '';
  const after = ` ${VERB[cause.kind]}${detail}.`;
  return {
    before: lead,
    cause: {
      featureId: cause.featureId,
      name,
      selectable: known !== undefined && cause.kind !== 'deleted',
    },
    after,
    text: `${lead}${name}${after}`,
  };
}

/**
 * All the sentences for one feature's status: one per unresolved reference that has a cause, or a
 * single one from the feature's own cause. Duplicate sentences collapse (three edges lost to the
 * same change read once).
 */
export function attentionSentences(input: {
  feature: string;
  state: 'needsAttention' | 'error' | 'blocked';
  unresolved?: readonly {
    ref: { kind: EntityKind };
    reason: 'missing' | 'ambiguous';
    cause?: AttentionCause | undefined;
  }[];
  cause?: AttentionCause | undefined;
  nameOf(id: Id): string | undefined;
}): AttentionSentence[] {
  const out = new Map<string, AttentionSentence>();
  const add = (s: AttentionSentence | null) => {
    if (s && !out.has(s.text)) out.set(s.text, s);
  };
  if (input.state === 'needsAttention' && input.unresolved?.some((u) => u.cause)) {
    for (const u of input.unresolved) {
      add(
        attentionSentence({
          feature: input.feature,
          state: input.state,
          ref: { kind: u.ref.kind, reason: u.reason },
          cause: u.cause ?? input.cause,
          nameOf: input.nameOf,
        }),
      );
    }
  } else {
    const u = input.unresolved?.[0];
    add(
      attentionSentence({
        feature: input.feature,
        state: input.state,
        ...(u ? { ref: { kind: u.ref.kind, reason: u.reason } } : {}),
        cause: input.cause ?? u?.cause,
        nameOf: input.nameOf,
      }),
    );
  }
  return [...out.values()];
}
