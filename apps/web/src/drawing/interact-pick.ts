/**
 * The picking tools on the sheet (Dimension, Angle, Ordinate, Chamfer, datums, frames, finishes,
 * notes, reattach): what a click picks, and what each tool makes of its picks.
 *
 * M4.1 (ADR-095): a section's cut edges pick the model face the cut runs through; tangent and
 * hidden lines pick when the view draws them; construction geometry is offered by the measuring
 * tools; a circle waits for a second pick (another circle: centre to centre; the same circle:
 * its diameter, Alt a radius, Shift its size in linear form); a curved outline that is not an arc
 * gives a radius on its face when that face is round; the Angle tool measures from the second
 * face's normal with Shift.
 */

import type { SheetDrag, SheetPointer } from '@wren-cad/ui/drawing';
import { hitTest } from '@wren-cad/ui/drawing';
import { CONSTRUCTION_TOOLS, constructionTargets, pickConstruction } from './construction';
import type { DrawingController } from './controller';
import {
  acrossAxis,
  addChamfer,
  addFinish,
  addNote,
  createDimension,
  createOrdinate,
  fromNormalProblem,
  pickEdge,
  reattachPick,
} from './ops-annot';
import { addRadiusOnFace } from './ops-forms';
import {
  addDatumOnSize,
  addDatumOnSurface,
  addFrameOnSize,
  addFrameOnSurface,
  dimensionAt,
} from './ops-gdt';
import type { DrawingTool, EdgePick } from './state';

/** After a first circle: what the Dimension tool waits for. */
export const CIRCLE_WAIT =
  'Pick a second edge or circle, or the same circle again for its diameter (Alt: radius)';

/**
 * What a picking tool picks at `p`: model geometry only (edges, outlines, cut edges), and with
 * `construction` the construction candidates too (ranked below every model edge). Those tools
 * pick geometry, never an annotation, so a dimension drawn over an edge (an extension line along
 * a fillet, say) does not hide that edge from them.
 */
export function viewHit(
  c: DrawingController,
  p: Pick<SheetPointer, 'at' | 'tol'>,
  construction = false,
) {
  const b = c.built();
  const sheetId = c.sheet()?.id;
  const composed = b && sheetId ? b.build.sheets.find((s) => s.sheetId === sheetId) : undefined;
  if (!b || !sheetId || !composed) return null;
  const items = composed.list.items.filter((i) => {
    const s = i.source;
    if (s?.kind !== 'view') return false;
    if (s.construction !== undefined) return construction;
    return s.edge !== undefined || s.face !== undefined || s.cut !== undefined;
  });
  if (construction) items.push(...constructionTargets(b, sheetId));
  return hitTest({ ...composed.list, items }, p.at, p.tol);
}

/** The pick under `p`: a cut edge's face, an edge, an outline's face, or a construction ref. */
export function edgeAt(
  c: DrawingController,
  p: Pick<SheetPointer, 'at' | 'tol'>,
  construction = false,
): EdgePick | null {
  const s = viewHit(c, p, construction)?.source;
  if (s?.kind !== 'view') return null;
  if (s.cut) return pickEdge(c, s.viewId, s.cut, p.at, 'cut');
  if (s.edge) return pickEdge(c, s.viewId, s.edge, p.at);
  // An outline has no edge name: with its face (`ProjectedCurve.face`) it picks that face.
  if (s.face) return pickEdge(c, s.viewId, s.face, p.at, 'face');
  const b = c.built();
  if (s.construction && b) return pickConstruction(b, s.viewId, s.construction, p.at);
  return null;
}

export function pickTool(c: DrawingController, _p: SheetPointer): SheetDrag {
  const tool = c.ui.get().tool;
  return {
    up(q, moved) {
      if (moved) return;
      // Datums and frames: a size dimension under the pointer means its feature of size.
      if (tool === 'datum' || tool === 'gdt') {
        const size = dimensionAt(c, q);
        if (size) {
          if (tool === 'datum') void addDatumOnSize(c, size);
          else addFrameOnSize(c, size);
          return;
        }
      }
      const pick = edgeAt(c, q, CONSTRUCTION_TOOLS.has(tool));
      if (!pick) {
        c.patch({ hint: { text: 'Pick an edge on a view', picks: c.ui.get().hint?.picks ?? [] } });
        return;
      }
      void onPick(c, tool, pick, { alt: q.alt, shift: q.shift });
    },
  };
}

/** One entity picked twice (same name, view and kind of ref). */
const sameEntity = (a: EdgePick, b: EdgePick) =>
  a.name === b.name && a.viewId === b.viewId && (a.ref ?? 'edge') === (b.ref ?? 'edge');

export async function onPick(
  c: DrawingController,
  tool: DrawingTool,
  pick: EdgePick,
  mods: { alt: boolean; shift: boolean },
): Promise<void> {
  switch (tool) {
    case 'dimension': {
      const prev = c.ui.get().hint?.picks ?? [];
      const first = prev[0];
      if (!first) {
        if (pick.shape === 'other') {
          // A curved outline that is not an arc (a fillet's torus): a radius on its face, if round.
          if (pick.ref === 'face' || pick.face) await addRadiusOnFace(c, pick);
          else c.toast('That edge is curved: pick a straight edge or a circle.', 'error');
          return;
        }
        c.patch({
          hint: {
            text:
              pick.shape === 'circle'
                ? CIRCLE_WAIT
                : pick.shape === 'point'
                  ? 'Pick a second edge, circle or point'
                  : 'Pick a second edge, or the same edge again for its length',
            picks: [pick],
          },
        });
        return;
      }
      c.patch({ hint: null });
      // The same circle again: its diameter (Alt: radius; Shift: across it, in linear form).
      if (first.shape === 'circle' && pick.shape === 'circle' && sameEntity(first, pick)) {
        const sv = c.built()?.build.views.get(pick.viewId);
        if (mods.shift && sv?.ok)
          await createDimension(c, [first], { across: acrossAxis(pick, sv) });
        else await createDimension(c, [first], mods.alt);
        return;
      }
      // Two picks of one face's outline are its two sides (a diameter), not one edge's length.
      const same =
        first.shape === 'line' && sameEntity(first, pick) && first.ref !== 'face' && !first.cut;
      await createDimension(c, same ? [first] : [first, pick]);
      return;
    }
    case 'angle': {
      const prev = c.ui.get().hint?.picks ?? [];
      const first = prev[0];
      if (pick.shape !== 'line') {
        c.toast('An angle is between two straight edges: pick a straight edge.', 'error');
        return;
      }
      if (!first) {
        c.patch({
          hint: {
            text: 'Pick the second edge (Shift: from the normal of its face, for a draft angle)',
            picks: [pick],
          },
        });
        return;
      }
      if (mods.shift) {
        const why = fromNormalProblem(pick);
        if (why) {
          c.toast(why, 'error');
          return;
        }
      }
      c.patch({ hint: null });
      await createDimension(c, [first, pick], mods.shift ? { fromNormal: true } : false);
      return;
    }
    case 'ordinate': {
      const origin = c.ui.get().hint?.picks[0];
      if (!origin) {
        if (pick.shape === 'other') {
          c.toast('Pick a straight edge or a circle for the origin.', 'error');
          return;
        }
        c.patch({
          hint: { text: 'Pick a feature to read from this origin; Esc finishes', picks: [pick] },
        });
        return;
      }
      if (pick.viewId !== origin.viewId) {
        c.toast('The features must be on the same view as the origin.', 'error');
        return;
      }
      if (pick.name === origin.name) {
        c.toast('That is the origin: pick a feature to measure from it.', 'error');
        return;
      }
      if (pick.shape === 'other') {
        c.toast('Pick a straight edge or a circle.', 'error');
        return;
      }
      // The origin stays picked: each further pick adds another coordinate to the group.
      await createOrdinate(c, [origin, pick]);
      c.patch({
        hint: { text: 'Pick the next feature, or Esc to finish', picks: [origin] },
      });
      return;
    }
    case 'chamfer':
      await addChamfer(c, pick);
      return;
    case 'datum':
      await addDatumOnSurface(c, pick);
      return;
    case 'gdt':
      await addFrameOnSurface(c, pick);
      return;
    case 'finish':
      await addFinish(c, pick);
      return;
    case 'note':
      await addNote(c, pick);
      return;
    case 'reattach':
      await reattachPick(c, pick);
      return;
    default:
      return;
  }
}
