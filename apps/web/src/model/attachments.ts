/**
 * Import attachments (`imports/<featureId>.<ext>`, ADR-008 item 3) outlive their ImportFeature
 * only as long as an undo could bring the feature back (ADR-016 item 9):
 *
 * - **Files never carry orphans.** What is saved (library, `.whittle`) holds the attachments the
 *   current document references, plus every non-import extra file (previews/, releases/...).
 * - **Memory keeps what the history can restore.** An attachment the document no longer
 *   references stays in memory while the undo/redo history still mentions its path (undoing the
 *   delete must find the bytes again); once the history has dropped it (it fell off the end, the
 *   redo branch was replaced, or the document was closed) it is pruned at the next save.
 */

import type { ProjectFiles, WhittleDoc } from '@whittle/contracts';

export const ATTACHMENT_DIR = 'imports/';

/** Attachment paths the document's import features reference. */
export function referencedAttachments(doc: WhittleDoc): Set<string> {
  const out = new Set<string>();
  for (const p of doc.parts)
    for (const f of p.features) if (f.type === 'import') out.add(f.source.path);
  return out;
}

/** Import attachments in `extra` that the document does not reference. */
export function orphanedAttachments(extra: ProjectFiles, doc: WhittleDoc): string[] {
  const used = referencedAttachments(doc);
  return [...extra.keys()].filter((k) => k.startsWith(ATTACHMENT_DIR) && !used.has(k));
}

/** The extra files to save with `doc`: everything except orphaned import attachments. */
export function savedExtra(extra: ProjectFiles, doc: WhittleDoc): ProjectFiles {
  const orphans = new Set(orphanedAttachments(extra, doc));
  if (orphans.size === 0) return extra;
  return new Map([...extra].filter(([k]) => !orphans.has(k)));
}

/**
 * Drops orphans the history can no longer restore from `extra` (in place). `mentions` answers
 * which paths the undo/redo history still mentions (`DocumentStoreImpl.historyMentions`).
 * Returns the dropped paths.
 */
export function pruneAttachments(
  extra: Map<string, Uint8Array>,
  doc: WhittleDoc,
  mentions: (paths: readonly string[]) => Set<string>,
): string[] {
  const orphans = orphanedAttachments(extra, doc);
  if (orphans.length === 0) return [];
  const kept = mentions(orphans);
  const dropped = orphans.filter((p) => !kept.has(p));
  for (const p of dropped) extra.delete(p);
  return dropped;
}
