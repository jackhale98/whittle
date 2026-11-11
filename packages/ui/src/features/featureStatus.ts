import type { FeatureStatus, Id } from '@wren-cad/contracts';
import { type AttentionSentence, attentionSentences } from '../inspector/attentionMessage';

export interface StatusLine {
  tone: 'danger' | 'warning' | 'muted';
  message: string;
  hint?: string | undefined;
  /** "<feature> lost its edge because <cause> changed": the cause name is a button. */
  sentence?: AttentionSentence | undefined;
}

export function describeStatus(
  s: FeatureStatus | undefined,
  name: string,
  nameOf: (id: Id) => string | undefined,
): StatusLine | null {
  if (!s) return null;
  const sentence =
    s.state === 'error' || s.state === 'needsAttention' || s.state === 'blocked'
      ? attentionSentences({
          feature: name,
          state: s.state,
          ...(s.unresolved ? { unresolved: s.unresolved } : {}),
          ...(s.cause ? { cause: s.cause } : {}),
          nameOf,
        })[0]
      : undefined;
  if (s.state === 'error') {
    return {
      tone: 'danger',
      message: sentence?.text ?? s.error?.message ?? 'This feature failed to rebuild.',
      hint: s.error?.hint,
      sentence,
    };
  }
  if (s.state === 'needsAttention' && s.error && !s.unresolved?.length) {
    // A configuration override that no longer applies (M3.7): the message names it.
    return { tone: 'warning', message: s.error.message, hint: s.error.hint, sentence };
  }
  if (s.state === 'needsAttention') {
    const n = s.unresolved?.length ?? 0;
    return {
      tone: 'warning',
      message:
        sentence?.text ??
        (n === 1 ? 'A reference needs re-picking.' : `${n || 'Some'} references need re-picking.`),
      hint: 'Select the feature and pick the highlighted references again.',
      sentence,
    };
  }
  if (s.state === 'blocked') {
    return {
      tone: 'muted',
      message: sentence?.text ?? 'Waiting on an earlier feature.',
      hint: 'Fix the failing feature above first.',
      sentence,
    };
  }
  // M3.8: a quiet note, never a warning: the feature rebuilt, but a reference now means more.
  if (s.state === 'ok' && s.grown?.length) {
    return {
      tone: 'muted',
      message: 'Check this reference',
      hint: 'A reference now covers much more than when you picked it. Select the feature to accept or re-pick it.',
    };
  }
  if (s.state === 'ok' && s.merged?.length) {
    return {
      tone: 'muted',
      message: 'Uses a merged face or edge',
      hint: 'A boolean merged a face or edge you picked into a neighbour. Select the feature to accept or re-pick it.',
    };
  }
  return null;
}
