/**
 * Test hooks (`Workbench.testHooks()`, exposed as `__wrenApp` in E2E): document, regen summary, idle.
 */

import type { Command, Id, WrenDoc } from '@wren-cad/contracts';
import { hitKey, resolvePick } from '../selection/pick';
import { marks } from './timing';
import type { Workbench } from './workbench';

export function testHooks(wb: Workbench) {
  return {
    doc: () => wb.doc,
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
