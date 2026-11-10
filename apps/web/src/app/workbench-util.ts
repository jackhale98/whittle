/** Small helpers shared by the workbench and the modules split out of it (pure functions and constants). */

import type { EntityRef, Feature, WrenDoc } from '@wren-cad/contracts';
import { newDoc, ulid } from '@wren-cad/document';
import { type FeatureTool, isFeatureTool, isUnset } from '../features/factories';

export const LAST_DOC_KEY = 'whittle:last-document';

/**
 * Library thumbnails read the WebGL canvas back (≈ 200 ms on software GL), so while editing they
 * are taken at most this often; flushes (page hidden, switching documents, opening the library)
 * and a document's first save always take one.
 */
export const THUMB_EVERY_MS = 30_000;

export function readLastDoc(): string | null {
  try {
    return localStorage.getItem(LAST_DOC_KEY);
  } catch {
    return null;
  }
}
export function writeLastDoc(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(LAST_DOC_KEY, id);
    else localStorage.removeItem(LAST_DOC_KEY);
  } catch {
    // storage blocked: the library still works, we just won't reopen automatically
  }
}

/** The M3 tool that makes a feature (its pick sequence), if any. */
export function toolOfFeature(f: Feature): FeatureTool | null {
  return isFeatureTool(f.type) ? f.type : null;
}

/** A reference field still to be picked: an empty list or an unset reference. */
export function emptyField(f: Feature, path: string): boolean {
  const v = pointerValue(f, path);
  if (Array.isArray(v)) return v.length === 0;
  return v === undefined || isUnset(v as EntityRef);
}

export function pointerValue(f: Feature, path: string): unknown {
  let cur: unknown = f;
  for (const s of path.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

export function fileBase(name: string): string {
  return (name.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-');
}

export function freshDocument(): WrenDoc {
  const doc = newDoc({ name: 'Untitled part', firstPart: 'Part 1' });
  return { ...doc, meta: { ...doc.meta, id: ulid() } };
}
