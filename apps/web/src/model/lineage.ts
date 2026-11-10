/**
 * Feature lineage (M3.5, owner request): where geometry came from and what depends on what, all
 * derived from persistent names (`F3:side(S1:e7)` = made by feature 3, whose sketch is 1) and from
 * the references features hold. Pure; nothing is stored.
 */

import type { Feature, Id, WrenDoc } from '@wren-cad/contracts';
import { entityRefs, nameTouchesFeature } from '@wren-cad/document';

export interface LineageRef {
  id: Id;
  name: string;
}

const ref = (f: Feature): LineageRef => ({ id: f.id, name: f.name });

/** The features a persistent name points into, oldest first (history order). */
function touching(features: readonly Feature[], name: string): Feature[] {
  return features.filter((f) => nameTouchesFeature(name, f.id));
}

/**
 * "Made by" for a face, edge or vertex: the latest feature in history that the name mentions (a
 * fillet's face names the fillet, an extrude's side names the extrude), and that feature's
 * sketch: the one its name or the feature's own profile references. Neither for geometry no
 * feature made (origin planes).
 */
export function selectionLineage(
  doc: WrenDoc,
  name: string,
): { madeBy?: LineageRef; sketch?: LineageRef } {
  const features = doc.parts[0]?.features ?? [];
  const hit = touching(features, name);
  const madeBy = hit.findLast((f) => f.type !== 'sketch');
  const sketches = hit.filter((f) => f.type === 'sketch');
  let sketch: Feature | undefined = sketches[sketches.length - 1];
  if (madeBy) {
    // The sketch the maker was built from, when the name itself no longer says (booleans, fillets).
    const own = entityRefs(madeBy)
      .map((r) => touching(features, r.name).findLast((f) => f.type === 'sketch'))
      .find((f) => f !== undefined);
    sketch = own ?? sketch;
  } else if (!sketch) return {};
  return { ...(madeBy ? { madeBy: ref(madeBy) } : {}), ...(sketch ? { sketch: ref(sketch) } : {}) };
}

/** What `feature` is built from: the latest feature each of its references points into. */
export function featureParents(doc: WrenDoc, feature: Feature): Feature[] {
  const features = doc.parts[0]?.features ?? [];
  const out = new Map<Id, Feature>();
  for (const r of entityRefs(feature)) {
    const maker = touching(features, r.name).findLast((f) => f.id !== feature.id);
    if (maker) out.set(maker.id, maker);
  }
  // Mirrors and patterns can take whole features as their source.
  if (
    (feature.type === 'mirror' ||
      feature.type === 'linearPattern' ||
      feature.type === 'circularPattern') &&
    feature.source.kind === 'features'
  ) {
    for (const id of feature.source.features) {
      const f = features.find((x) => x.id === id);
      if (f) out.set(f.id, f);
    }
  }
  return features.filter((f) => out.has(f.id));
}

/** Parents (what it references) and children (what references it) of a feature, history order. */
export function featureLineage(
  doc: WrenDoc,
  id: Id,
): { parents: LineageRef[]; children: LineageRef[] } {
  const features = doc.parts[0]?.features ?? [];
  const self = features.find((f) => f.id === id);
  if (!self) return { parents: [], children: [] };
  return {
    parents: featureParents(doc, self).map(ref),
    children: features
      .filter((f) => f.id !== id && featureParents(doc, f).some((p) => p.id === id))
      .map(ref),
  };
}
