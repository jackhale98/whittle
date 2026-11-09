/**
 * Sketch Edit-menu tools (PLAN 12 M3 "sketch editing", ADR-033…035, ADR-038): offset, convert
 * entities, trim / extend, sketch fillet / chamfer, sketch mirror, and unlink / re-pick of linked
 * geometry. The panels in packages/ui are controlled from `SketchUi.edit`; every Apply (and every
 * trim click) runs one pure `@wren-cad/sketch/edit` operation through the sketch session's edit
 * queue, so it is solved, lands as one `updateFeature` and is one undo step labelled with the
 * operation's own description ("Offset 4 entities by 5 mm").
 *
 * Convert entities projects model edges (or a face's outline) onto the sketch plane in the kernel
 * worker (`projectEdges` / `projectFaceOutline`); the main thread never touches Wasm. The links are
 * kept up to date on every regen by the engine (`RegenEngineDeps.reprojectLinked`, wired to the
 * sketch package's `reprojectLinked` in packages/kernel-client).
 *
 * `@wren-cad/sketch/edit` is loaded on first use, so entering a sketch doesn't pay for it.
 */

import type {
  EntityRef,
  Frame,
  Id,
  PickHit,
  SketchEntity,
  SketchFeature,
  Vec2,
} from '@wren-cad/contracts';
import type { KernelProjectionApi } from '@wren-cad/kernel-client';
import { isSketchReference, SKETCH_X_AXIS, SKETCH_Y_AXIS } from '@wren-cad/sketch';
import type { SketchEditToolId } from '@wren-cad/ui';
import type { PlaneFrame } from '../model/frames';
import { resolvePick } from '../selection/pick';
import type { SketchData } from '../sketch/draw';
import type { ConvertPick, SketchEditUi, SketchUi } from './state';
import type { Workbench } from './workbench';

type EditModule = typeof import('@wren-cad/sketch/edit');
type EditResult = ReturnType<EditModule['trimEntity']>;
type ProjectedEdge = Parameters<EditModule['convertEntities']>[1][number];

let editModule: Promise<EditModule> | null = null;
const loadEdit = (): Promise<EditModule> => {
  editModule ??= import('@wren-cad/sketch/edit');
  return editModule;
};

/** What the edit tools need from the sketch session. */
export interface EditHost {
  readonly wb: Workbench;
  feature(): SketchFeature | null;
  sketchUi(): SketchUi | null;
  /** Replaces the edit state (null ends the tool). */
  setEdit(edit: SketchEditUi | null): void;
  /** Solves and writes an edit (one undo step); the edit sees the sketch as it is when it runs. */
  commitEdit(
    edit: (cur: SketchFeature) => SketchData,
    label: string | (() => string),
  ): Promise<void>;
  /** The current selection of the select tool (select first, act second). */
  selected(): Id[];
}

const DEFAULT_VALUE: Partial<Record<SketchEditToolId, string>> = {
  offset: '5 mm',
  sketchFillet: '2 mm',
  sketchChamfer: '2 mm',
};

export const isEditTool = (t: string | null): t is SketchEditToolId =>
  t === 'offset' ||
  t === 'convert' ||
  t === 'trim' ||
  t === 'extend' ||
  t === 'sketchFillet' ||
  t === 'sketchChamfer' ||
  t === 'sketchMirror';

/** A fresh edit state for `tool`; offset and mirror start from the current selection. */
export function startEdit(
  tool: SketchEditToolId,
  entities: readonly SketchEntity[],
  selected: readonly Id[],
): SketchEditUi {
  const curves = selected.filter((id) => {
    const e = entities.find((x) => x.id === id);
    return !!e && e.kind !== 'point';
  });
  const points = selected.filter((id) => entities.find((x) => x.id === id)?.kind === 'point');
  return {
    tool,
    picks:
      tool === 'offset' || tool === 'sketchMirror'
        ? curves
        : tool === 'sketchFillet' || tool === 'sketchChamfer'
          ? points
          : [],
    value: DEFAULT_VALUE[tool] ?? '',
    side: 'left',
    both: false,
    corner: tool === 'sketchChamfer' ? 'chamfer' : 'fillet',
    trim: tool === 'extend' ? 'extend' : 'trim',
    phase: 'entities',
    axis: null,
    source: 'edges',
    model: [],
    relink: null,
    busy: false,
  };
}

/** Kernel frame of a sketch plane (origin, normal, x). */
const kernelFrame = (f: PlaneFrame): Frame => ({ origin: f.origin, z: f.z, x: f.x });

type Projection = Partial<KernelProjectionApi>;

export class SketchEditTools {
  constructor(private readonly host: EditHost) {}

  private get edit(): SketchEditUi | null {
    return this.host.sketchUi()?.edit ?? null;
  }

  private patch(p: Partial<SketchEditUi>): void {
    const e = this.edit;
    if (e) this.host.setEdit({ ...e, ...p });
  }

  private toast(text: string): void {
    this.host.wb.toast(text, 'info');
  }

  // ------------------------------------------------------------------ panel controls

  setValue(value: string): void {
    this.patch({ value });
  }

  setSide(side: 'left' | 'right'): void {
    this.patch({ side });
  }

  setBoth(both: boolean): void {
    this.patch({ both });
  }

  setCorner(corner: 'fillet' | 'chamfer'): void {
    this.patch({ corner, tool: corner === 'fillet' ? 'sketchFillet' : 'sketchChamfer' });
  }

  setTrim(trim: 'trim' | 'extend'): void {
    this.patch({ trim, tool: trim });
  }

  setPhase(phase: 'entities' | 'axis'): void {
    this.patch({ phase });
  }

  setSource(source: 'edges' | 'face'): void {
    this.patch({ source, model: [] });
  }

  cancel(): void {
    this.host.setEdit(null);
  }

  // ------------------------------------------------------------------ clicks

  /**
   * A click while an edit tool is active. `hit` is the sketch pick under the pointer (entities,
   * the origin and axes); model picks (convert, re-pick) are taken from the viewport here.
   */
  async click(
    hit: PickHit | null,
    at: Vec2 | null,
    screen: { x: number; y: number; pointerType: string },
  ): Promise<void> {
    const e = this.edit;
    const f = this.host.feature();
    if (!e || !f) return;
    const id = hit?.entity ?? null;
    const kindOf = (x: Id) => f.entities.find((y) => y.id === x)?.kind;
    switch (e.tool) {
      case 'offset': {
        if (!id || isSketchReference(id) || kindOf(id) === 'point') return;
        this.patch({ picks: toggle(e.picks, id) });
        return;
      }
      case 'sketchMirror': {
        if (!id) return;
        if (e.phase === 'axis') {
          const axisOk = id === SKETCH_X_AXIS || id === SKETCH_Y_AXIS || kindOf(id) === 'line';
          if (!axisOk) return this.toast('Pick a line or an axis to mirror about.');
          this.patch({ axis: id });
          return;
        }
        if (isSketchReference(id)) return;
        this.patch({ picks: toggle(e.picks, id) });
        return;
      }
      case 'sketchFillet':
      case 'sketchChamfer': {
        if (!id || kindOf(id) !== 'point') return this.toast('Click the corner point.');
        this.patch({ picks: toggle(e.picks, id) });
        return;
      }
      case 'trim':
      case 'extend': {
        if (!id || isSketchReference(id) || !at) return;
        const kind = kindOf(id);
        if (!kind || kind === 'point') return;
        await this.run((m, cur) =>
          e.tool === 'trim' ? m.trimEntity(cur, id, at) : m.extendEntity(cur, id, at),
        );
        return;
      }
      case 'convert': {
        const pick = this.modelPick(screen, e.relink ? 'edges' : e.source);
        if (!pick) return;
        if (e.relink) {
          await this.relink(e.relink, pick);
          return;
        }
        const ref = await this.host.wb.refFor(pick.hit);
        const item: ConvertPick = {
          bodyId: pick.hit.bodyId,
          kind: pick.kind,
          index: pick.hit.index,
          point: pick.hit.point,
          ref,
        };
        const cur = this.edit;
        if (!cur) return;
        const key = (p: ConvertPick) => `${p.bodyId}|${p.kind}|${p.index}`;
        const exists = cur.model.some((p) => key(p) === key(item));
        // One face outline at a time; edges add up.
        const model =
          cur.source === 'face'
            ? [item]
            : exists
              ? cur.model.filter((p) => key(p) !== key(item))
              : [...cur.model, item];
        this.patch({ model });
        return;
      }
    }
  }

  /** The model edge / face under the pointer (sketch mode shows the model behind the sketch). */
  private modelPick(
    screen: { x: number; y: number; pointerType: string },
    source: 'edges' | 'face',
  ): { hit: PickHit; kind: 'edge' | 'face' } | null {
    const kind = source === 'face' ? 'face' : 'edge';
    const hits = this.host.wb.pickAt(screen.x, screen.y, screen.pointerType, [kind]);
    const best = resolvePick(hits, { pointerType: screen.pointerType }).best;
    return best && best.kind === kind ? { hit: best, kind } : null;
  }

  // ------------------------------------------------------------------ apply

  /** Enter / the panel's Apply. */
  async apply(): Promise<void> {
    const e = this.edit;
    if (!e || e.busy) return;
    switch (e.tool) {
      case 'offset': {
        const d = this.length(e.value);
        if (d === null) return;
        const picks = e.picks;
        const side = e.both ? 'both' : e.side;
        const ok = await this.run((m, cur) =>
          m.offsetEntities(cur, picks, { distance: Math.abs(d), expr: e.value, side }),
        );
        if (ok) this.patch({ picks: [] });
        return;
      }
      case 'sketchFillet':
      case 'sketchChamfer': {
        const d = this.length(e.value);
        if (d === null) return;
        let ok = true;
        for (const corner of e.picks) {
          ok &&= await this.run((m, cur) =>
            e.tool === 'sketchFillet'
              ? m.filletCorner(cur, corner, { radius: d, expr: e.value })
              : m.chamferCorner(cur, corner, { distance: d, expr: e.value }),
          );
        }
        if (ok) this.patch({ picks: [] });
        return;
      }
      case 'sketchMirror': {
        if (!e.axis) {
          this.patch({ phase: 'axis' });
          return this.toast('Pick the mirror line.');
        }
        const axis = e.axis;
        const ok = await this.run((m, cur) => m.mirrorEntities(cur, e.picks, axis));
        if (ok) this.patch({ picks: [], axis: null, phase: 'entities' });
        return;
      }
      case 'convert':
        await this.convert();
        return;
      case 'trim':
      case 'extend':
        this.cancel();
        return;
    }
  }

  /** Unlinks the selected linked entities (keeps the geometry). */
  async unlink(ids: readonly Id[]): Promise<void> {
    await this.run((m, cur) => m.unlinkEntities(cur, ids));
  }

  /** Starts a Re-pick of a lost source: the next model edge click re-links its entities. */
  startRelink(refName: string): void {
    const f = this.host.feature();
    if (!f) return;
    this.host.setEdit({ ...startEdit('convert', f.entities, []), relink: refName });
  }

  private length(expr: string): number | null {
    const r = this.host.wb.evaluate(expr, 'length');
    if (!r.ok || typeof r.value !== 'number' || !(Math.abs(r.value) > 0)) {
      this.toast('Type a length greater than zero.');
      return null;
    }
    return r.value;
  }

  /**
   * Runs one edit operation on the sketch as it is when the queued edit runs. A refusal is shown
   * as a toast (plain language from the sketch package) and changes nothing.
   */
  private async run(
    op: (m: EditModule, cur: SketchData & SketchDataMut) => EditResult,
  ): Promise<boolean> {
    const m = await loadEdit();
    let label = 'Edit sketch';
    let refused: string | null = null;
    let notes: string[] = [];
    this.patch({ busy: true });
    await this.host.commitEdit(
      (cur) => {
        const r = op(m, { entities: [...cur.entities], constraints: [...cur.constraints] });
        if (!r.ok) {
          refused = r.reason;
          return cur;
        }
        label = r.description;
        notes = r.notes;
        return r.sketch;
      },
      () => label,
    );
    this.patch({ busy: false });
    if (refused) {
      this.toast(refused);
      return false;
    }
    if (notes.length) this.toast(notes.join(' '));
    return true;
  }

  /** Projects the picked model edges (or face outline) in the kernel worker and converts them. */
  private async convert(): Promise<void> {
    const e = this.edit;
    const frame = this.host.sketchUi()?.frame;
    if (!e || !frame || e.model.length === 0) return;
    this.patch({ busy: true });
    const edges = await this.project(e.model, frame);
    this.patch({ busy: false });
    if (!edges) return;
    if (edges.length === 0) return this.toast('Those edges are seen end-on from this sketch.');
    const ok = await this.run((m, cur) => m.convertEntities(cur, edges));
    if (ok) this.patch({ model: [] });
  }

  private async relink(
    refName: string,
    pick: { hit: PickHit; kind: 'edge' | 'face' },
  ): Promise<void> {
    const frame = this.host.sketchUi()?.frame;
    if (!frame) return;
    const ref = await this.host.wb.refFor(pick.hit);
    const edges = await this.project(
      [
        {
          bodyId: pick.hit.bodyId,
          kind: 'edge',
          index: pick.hit.index,
          point: pick.hit.point,
          ref,
        },
      ],
      frame,
    );
    const edge = edges?.[0];
    if (!edge) return this.toast('That edge can’t be projected onto this sketch.');
    const ok = await this.run((m, cur) => m.relinkEntities(cur, refName, edge));
    if (ok) this.cancel();
  }

  /** Model picks → projected edges (refs from the engine, curves from the kernel). */
  private async project(
    picks: readonly ConvertPick[],
    frame: PlaneFrame,
  ): Promise<ProjectedEdge[] | null> {
    const wb = this.host.wb;
    const port = wb.modeling?.port as Projection | undefined;
    const bodies = wb.regen.get()?.result.bodies ?? [];
    if (!port?.projectEdges || !port.projectFaceOutline) {
      this.toast('The geometry kernel is still starting; try again in a moment.');
      return null;
    }
    const out: ProjectedEdge[] = [];
    for (const p of picks) {
      const body = bodies.find((b) => b.id === p.bodyId);
      if (!body) continue;
      if (p.kind === 'edge') {
        const ref = p.ref ?? (await wb.refFor(asHit(p)));
        const r = await port.projectEdges(body.shape, [p.index], kernelFrame(frame));
        if (!r.ok) return this.fail(r.error.message);
        for (const c of r.value[0]?.curves ?? []) if (ref) out.push({ ref, curve: c });
        continue;
      }
      const r = await port.projectFaceOutline(body.shape, p.index, kernelFrame(frame));
      if (!r.ok) return this.fail(r.error.message);
      for (const edge of r.value) {
        const ref = await wb.refFor({ ...asHit(p), kind: 'edge', index: edge.edge });
        for (const c of edge.curves) if (ref) out.push({ ref, curve: c });
      }
    }
    return out;
  }

  private fail(message: string): null {
    this.toast(message);
    return null;
  }
}

type SketchDataMut = { entities: SketchEntity[]; constraints: SketchFeature['constraints'] };

const toggle = (list: readonly Id[], id: Id): Id[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

const asHit = (p: ConvertPick): PickHit => ({
  bodyId: p.bodyId,
  kind: p.kind,
  index: p.index,
  point: p.point,
  distancePx: 0,
});

/** Linked entities of a sketch, by stored source, for the Linked panel. */
export function linkedSources(
  f: SketchFeature,
  ids: readonly Id[],
): { ref: EntityRef; ids: Id[]; approximate: boolean }[] {
  const out = new Map<string, { ref: EntityRef; ids: Id[]; approximate: boolean }>();
  for (const id of ids) {
    const e = f.entities.find((x) => x.id === id);
    if (!e?.source) continue;
    const g = out.get(e.source.ref.name) ?? { ref: e.source.ref, ids: [], approximate: false };
    g.ids.push(id);
    g.approximate ||= e.source.approximate === true;
    out.set(e.source.ref.name, g);
  }
  return [...out.values()];
}
