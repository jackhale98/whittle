/**
 * Plain-language feature errors the app can say better than the engine (PLAN 9.2 "one-line human
 * explanation and a suggested fix"). Today: fillet / chamfer with "Propagate along tangent edges"
 * off. OCCT cannot stop a blend inside a tangent chain, so the kernel refuses with
 * UNSUPPORTED_FEATURE and lists the selection plus the tangent edges it would pull in (ADR-040);
 * the message here names those edges in the user's own terms.
 */

import type { Feature, FeatureStatus, Id, WrenDoc } from '@wren-cad/contracts';
import { Namer } from '@wren-cad/sketch';

/** "fillet face of Fillet 1", "side of Arc 2 (Extrude 1)", "end face of Extrude 1". */
export function describeFaceName(doc: WrenDoc, name: string): string {
  const part = doc.parts[0];
  const m = /^F([0-9A-Z]+):(.*)$/.exec(name);
  const f = m ? part?.features.find((x) => x.id === m[1]) : undefined;
  if (!m || !f) return 'a face';
  const role = m[2] as string;
  // Boolean / push-pull images keep the original face name inside `face(...)`.
  const inner = /^face\((.*)\)$/.exec(role);
  if (inner) return describeFaceName(doc, inner[1] as string);
  const side = /^side\(S([0-9A-Z]+):e\(([^)]+)\)\)$/.exec(role);
  if (side) {
    const sk = part?.features.find((x) => x.id === side[1]);
    const curve = sk?.type === 'sketch' ? new Namer(sk.entities).entity(side[2] as Id) : 'a curve';
    return `side of ${curve} (${f.name})`;
  }
  const word = /^[a-z]+/i.exec(role)?.[0] ?? 'face';
  const noun: Record<string, string> = {
    end: 'end face',
    start: 'start face',
    fillet: 'fillet face',
    chamfer: 'chamfer face',
    wall: 'wall',
    rim: 'rim',
  };
  return `${noun[word] ?? `${word} face`} of ${f.name}`;
}

/** "the edge between the end face of Extrude 1 and the side of Arc 2 (Extrude 1)". */
export function describeEdgeName(doc: WrenDoc, name: string): string {
  const m = /^edge\((.*)\)$/.exec(name);
  if (!m) return 'an edge';
  // Split `A|B` at the top-level bar (names nest parentheses).
  const body = m[1] as string;
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return 'an edge';
  const a = describeFaceName(doc, body.slice(0, cut));
  const b = describeFaceName(doc, body.slice(cut + 1));
  return `the edge between the ${a} and the ${b}`;
}

const isBlend = (f: Feature | undefined): f is Extract<Feature, { type: 'fillet' | 'chamfer' }> =>
  f?.type === 'fillet' || f?.type === 'chamfer';

/**
 * The status with a clearer message where the app knows one. A fillet or chamfer that may not
 * propagate and was refused for tangent edges names the edges that would be pulled in and how to
 * proceed; the kernel's own text stays in `detail`.
 */
export function explainStatus(doc: WrenDoc, status: FeatureStatus): FeatureStatus {
  const e = status.error;
  if (!e) return status;
  if (e.code !== 'UNSUPPORTED_FEATURE') return status;
  const f = doc.parts[0]?.features.find((x) => x.id === status.featureId);
  if (!isBlend(f) || f.propagate !== false) return status;
  const picked = new Set(f.edges.map((r) => r.name));
  const extra = (e.entityRefs ?? []).filter((n) => !picked.has(n) && n.startsWith('edge('));
  if (extra.length === 0) return status;
  const what = f.type === 'fillet' ? 'fillet' : 'chamfer';
  const n = extra.length;
  const list = extra.map((x) => describeEdgeName(doc, x));
  return {
    ...status,
    error: {
      ...e,
      message: `The ${what} can’t stop at a tangent edge: ${n} tangent edge${n === 1 ? '' : 's'} continue${n === 1 ? 's' : ''} the selection (${list.join('; ')}).`,
      hint: `Turn on “Propagate along tangent edges”, or add ${n === 1 ? 'that edge' : 'those edges'} to the selection.`,
      detail: [e.detail, e.message].filter(Boolean).join(' · '),
    },
  };
}
