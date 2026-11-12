/**
 * Test hooks (`Workbench.testHooks()`, exposed as `__wrenApp` in E2E): document, regen summary, idle.
 */

import type { Command, Id, MotionInputState, WrenDoc } from '@wren-cad/contracts';
import type { MotionInputLike } from '@wren-cad/ui';
import { ensureDrawingSupport } from '../doc/drawing-support';
import { hitKey, resolvePick } from '../selection/pick';
import { configStatusOf, isMissingActive, keyOf } from './config-model';
import { refAcks, type StubNotes } from './ref-notes';
import { marks } from './timing';
import type { Workbench } from './workbench';

export function testHooks(wb: Workbench) {
  return {
    doc: () => wb.doc,
    /** Settles once the lazily loaded annotation and drawing support has registered. */
    drawingSupport: () => ensureDrawingSupport(),
    /** The section manipulator's grips (offset arrow, two arcs) in canvas CSS px. */
    sectionGrips: () => wb.sectionTool.grips(),
    regen: () => {
      const view = wb.regen.get();
      const r = view?.result;
      return r && view
        ? {
            revision: r.revision,
            source: view.source,
            quality: view.quality,
            rollback: view.doc.parts[0]?.rollbackIndex ?? null,
            bodies: r.bodies.map((b) => ({
              id: b.id,
              volume: b.massProperties?.volume ?? null,
              faces: b.mesh.faceNames.length,
              bbox: b.mesh.bbox,
            })),
            features: r.features.map((f) => ({
              id: f.featureId,
              state: f.state,
              ...(f.unresolved ? { unresolved: f.unresolved } : {}),
              ...(f.rebound ? { rebound: f.rebound } : {}),
              ...(f.merged ? { merged: f.merged } : {}),
              ...(f.grown ? { grown: f.grown } : {}),
              ...(f.error ? { error: f.error.message } : {}),
            })),
            sketches: r.sketches.map((s) => ({
              id: s.featureId,
              regions: s.regions.map((x) => x.name),
            })),
          }
        : null;
    },
    shownSketches: () => [...wb.shownSketches],
    /** Ids of the bodies the viewport holds (what is on screen). */
    shownBodies: () => [...wb.shownBodies],
    /** Collapsed folders of the open document (UI state, per document). */
    collapsedFolders: () => [...wb.collapsedFolders.get()],
    /** Opens a feature for editing (a sketch enters sketch mode). */
    editFeature: (id: Id) => wb.editFeature(id),
    idle: async () => {
      await wb.sketch?.whenSettled();
      await wb.boot?.modeling;
      // (Phones may not have started the kernel at all: then there is nothing to wait for.)
      for (let i = 0; i < 50 && wb.boot && !wb.loop; i++)
        await new Promise((r) => setTimeout(r, 20));
      // Settled = no UI action in flight, the regen loop idle, and the last live result is of
      // the document as displayed now (not of the version before the last edit).
      for (let i = 0; i < 200; i++) {
        while (wb.actions.size > 0) await Promise.allSettled([...wb.actions]);
        await wb.sketch?.whenSettled();
        await wb.loop?.whenIdle();
        const r = wb.regen.get();
        if (!wb.loop || (r?.source === 'live' && r.doc === wb.viewDoc())) break;
        if (wb.actions.size === 0 && !wb.ui.get().ready) break;
        await new Promise((res) => setTimeout(res, 25));
      }
      await wb.viewport?.nextFrame();
    },
    flushSave: () => wb.flushSave(),
    /**
     * What a mouse click at canvas px would pick in the current mode, as the click itself
     * resolves it (`pickAt` + `resolvePick`): the best hit and how many tie ("Which one?").
     */
    resolveAt: (x: number, y: number) => {
      const r = resolvePick(wb.pickAt(x, y, 'mouse', wb.pickKinds()), {
        pointerType: 'mouse',
      });
      return {
        best: r.best
          ? {
              bodyId: r.best.bodyId,
              kind: r.best.kind,
              index: r.best.index,
              ...(r.best.entity !== undefined ? { entity: r.best.entity } : {}),
              point: r.best.point,
              distancePx: r.best.distancePx,
            }
          : null,
        ties: r.ties.length,
      };
    },
    /** The persistent name of a viewport hit's face or edge (read only; E2E pick checks). */
    hitName: (bodyId: string, kind: string, index: number): string | null => {
      const mesh = wb.regen.get()?.result.bodies.find((b) => b.id === bodyId)?.mesh;
      if (kind === 'face') return mesh?.faceNames[index] ?? null;
      if (kind === 'edge') return mesh?.edgeNames[index] ?? null;
      return null;
    },
    sketch: () => {
      const solve = wb.ui.get().sketch?.solve;
      return solve ? { ...solve, busy: wb.sketch?.busy ?? false } : null;
    },
    sketchSettled: () => wb.sketch?.whenSettled() ?? Promise.resolve(),
    sketchSettleState: () => wb.sketch?.settleState() ?? null,
    marks: () => marks(),
    ui: () => {
      const u = wb.ui.get();
      return {
        featureId: u.featureId,
        picking: u.picking,
        candidates: u.candidates?.names ?? null,
        toast: u.toast?.text ?? null,
        sketch: u.sketch
          ? {
              featureId: u.sketch.featureId,
              plane: u.sketch.frame,
              edit: u.sketch.edit
                ? {
                    tool: u.sketch.edit.tool,
                    picks: u.sketch.edit.picks.length,
                    model: u.sketch.edit.model.length,
                    busy: u.sketch.edit.busy,
                  }
                : null,
              tool: u.sketch.tool,
              dimPicks: u.sketch.dimPicks,
              editDimension: u.sketch.editDimension,
              shownRadius: shownRadius(
                u.sketch.shown,
                wb.part?.features.find((x) => x.id === u.sketch?.featureId),
              ),
              frame: u.sketch.frame !== null,
              highlight: u.sketch.highlightConstraints,
              highlightEntities: u.sketch.highlightEntities,
              selected: u.sketch.selected,
              hover: u.sketch.hoverEntity,
              stroke: u.sketch.stroke
                ? { shape: u.sketch.stroke.shape, points: u.sketch.stroke.points.length }
                : null,
              lastStroke: u.sketch.lastStroke,
            }
          : null,
        selection: u.selection.map((x) => x.hit.kind),
        selectionKeys: u.selection.map((x) => x.key),
        hover: u.hover?.kind ?? null,
        choices: wb.choices,
        prompt: u.prompt?.tool ?? null,
        pushPull: u.pushPull
          ? {
              faces: u.pushPull.faces.length,
              distance: u.pushPull.distance,
              expr: u.pushPull.expr,
              dragging: u.pushPull.dragging,
            }
          : null,
        measure: u.measure
          ? {
              active: u.measure.active,
              picks: u.measure.picks.map((p) => p.kind),
              results: u.measure.results,
              busy: u.measure.busy,
              error: u.measure.error,
            }
          : null,
        section: {
          enabled: u.section.enabled,
          axis: u.section.axis,
          offset: u.section.offset,
          flipped: u.section.flipped,
          picking: u.section.picking,
          open: u.section.open,
          tiltU: u.section.tiltU,
          tiltV: u.section.tiltV,
        },
        bubble: u.bubble !== null,
        chooser: u.chooser?.hits.map((h) => h.kind) ?? null,
        radial: u.radial
          ? {
              source: u.radial.source,
              held: u.radial.held === true,
              x: u.radial.x,
              y: u.radial.y,
            }
          : null,
        box: u.box ? { mode: u.box.mode } : null,
        settings: u.settings,
        hoverKey: u.hover ? hitKey(u.hover) : null,
        tabOrder: wb.lastPick.map((c) => c.id),
        lastTool: u.lastTool,
        sheet: { snap: u.sheetSnap, tab: u.sheetTab },
        kernel: { started: wb.boot !== null, ready: wb.engine.get().ready },
        camera: wb.camera.get(),
      };
    },
    /** The undo and redo stacks, oldest first (labels of the steps; read only). */
    history: () => wb.store.history(),
    /**
     * M4.5: a controllable fake MotionInput (E2E; the real one needs hardware). `attach` plugs it
     * in; `emit` sets its state; `press` simulates a button press (a state edge, like the 10 Hz feed).
     */
    motion: () => import('./motion-fake').then((m) => m.motionHooks(wb)),
    /** Applies a command as one undo step (E2E edits that aren't about the UI path). */
    apply: (command: Command, label?: string) => {
      const ok = wb.apply(command, label);
      wb.commit();
      return ok;
    },
    /** M2.5: the sync controller's state (loads the sync chunk). */
    sync: async () => {
      const c = await wb.syncController();
      await c.idle();
      return c.testState();
    },
    /** M2.5: sync the open project now and wait for it to settle. */
    syncNow: async () => {
      const c = await wb.syncController();
      await c.syncNow();
      await c.idle();
    },
    syncLoaded: () => wb.syncCtl !== null,
    /** The sync controller itself (only usable inside page.evaluate). */
    syncController: () => wb.syncController(),
    projectBar: () => wb.projectBar.get(),
    /** Replaces the document (fixtures for E2E scenarios), saved to the library. */
    load: (doc: WrenDoc) => {
      if (wb.loadDocument({ doc }, false)) wb.autosaver.schedule(doc);
    },
    projectFiles: () => ({
      extra: [...wb.extra.keys()].sort(),
      cache: [...wb.cache.keys()].sort(),
      cacheKey: wb.cacheKey,
      savedCacheKey: wb.savedCacheKey,
    }),
    sentAttachments: () => [...(wb.loop?.sentAttachments ?? [])],
    /** Ghost markers at the old location of unresolved references. */
    attentionMarkers: () => [...wb.markers],
    pendingHeals: () => Object.fromEntries(wb.heals),
    library: async () => {
      const lib = await wb.library();
      return (await lib?.list())?.map((e) => ({ id: e.id, name: e.name })) ?? [];
    },
    libraryFiles: async (id: string) => {
      const lib = await wb.library();
      const b = await lib?.open(id);
      return [...(b?.extra?.keys() ?? [])].sort();
    },
    /**
     * M3.7: the active configuration, the status and mass of each configuration (from the
     * background builds; the active one from the live regen) and the last switch's timing.
     */
    configurations: () => {
      const doc = wb.doc;
      const part = doc.parts[0];
      const active = part?.activeConfigurationId ?? null;
      const live = wb.regen.get();
      const out: Record<
        string,
        { status: string; mass: number | null; ms: number | null; message?: string }
      > = {};
      const statuses = wb.treeStatuses.get();
      for (const id of [null, ...(part?.configurations ?? []).map((c) => c.id)] as (Id | null)[]) {
        const key = keyOf(id);
        if (id === active) {
          const s = configStatusOf(
            live?.source === 'live' ? statuses : undefined,
            wb.config.resolved().issues,
            (f) => f,
          );
          out[key] = {
            status: isMissingActive(part) ? 'attention' : s.status,
            mass: wb.massSummary()?.mass ?? null,
            ms: null,
          };
          continue;
        }
        const e = wb.config.builds.entry(doc, id);
        out[key] = {
          status: e?.status ?? 'unbuilt',
          mass: e?.mass?.mass ?? null,
          ms: e?.ms ?? null,
          ...(e?.message ? { message: e.message } : {}),
        };
      }
      return {
        active,
        missing: isMissingActive(part),
        builds: out,
        building: wb.config.builds.view.get().building,
        lastSwitch: wb.config.lastSwitch.get(),
      };
    },
    /** Waits for the settled live regen and the background builds of the other configurations. */
    configurationsBuilt: async () => {
      for (let i = 0; i < 400; i++) {
        await wb.loop?.whenIdle();
        const part = wb.part;
        const ids = [null, ...(part?.configurations ?? []).map((c) => c.id)] as (Id | null)[];
        const active = part?.activeConfigurationId ?? null;
        const done = ids.every((id) => id === active || wb.config.builds.entry(wb.doc, id));
        if (done && !wb.config.builds.pending) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    },
    /** Slows each configuration of "Export all" (ms), so a test can act while it runs. */
    slowExport: (ms: number) => {
      wb.config.exportDelayMs = ms;
    },
    /** Regen slots the kernel holds for the part (memory guard: config slots are released). */
    kernelSlots: async () => {
      const m = await wb.modeling?.port.memoryStats?.();
      return (m?.regen.slots ?? []).map((s) => s.slot);
    },
    /**
     * Adds merged / grown references to a feature's status as the kernel would report them (for
     * UI states a model can't easily reach); `null` removes the stub. The UI treats them like
     * reported ones.
     */
    stubRefNotes: (featureId: Id, notes: StubNotes | null) => refAcks.stub(featureId, notes),
    /** Simulates "Export all" holding the live slot (picks and measurements are refused). */
    holdExport: (on: boolean) => wb.config.setExportingAll(on),
    /** Number of `regenerate` calls the loop made (the background builds are not counted). */
    regenCalls: () => wb.loop?.calls ?? 0,
    /** Waits until the mesh cache of the current document has reached the library. */
    cacheSaved: async () => {
      for (let i = 0; i < 200; i++) {
        await wb.loop?.whenIdle();
        await wb.autosaver.flush();
        if (wb.cacheKey && wb.cacheKey === wb.savedCacheKey) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    },
  };
}

/**
 * The radius of the first circle in the display-only solved sketch; null when none is shown or it
 * is stale (solved from entities the document no longer holds, so it is not what is drawn).
 */
function shownRadius(
  shown: { for: unknown; entities: readonly { kind: string; radius?: number }[] } | null,
  stored: object | undefined,
) {
  if (!shown || shown.for !== (stored as { entities?: unknown } | undefined)?.entities) return null;
  return shown.entities.find((e) => e.kind === 'circle')?.radius ?? null;
}
