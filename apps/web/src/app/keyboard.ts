/**
 * Keyboard and command dispatch: key handling, input settings, repeat-last, the radial menu and Tab cycling.
 */

import type { PickHit, TouchViewport } from '@wren-cad/contracts';
import {
  cyclePreselection,
  eventBindingId,
  type KeymapOverrides,
  type SketchToolId,
  sortCandidates,
} from '@wren-cad/ui';
import type { FeatureTool, ModelTool } from '../features/factories';
import { hitKey } from '../selection/pick';
import type { BubbleActionId } from './gestures';
import { commandFor, type InputSettings, withKeymap, withNavigation } from './input';
import type { SettingsTab } from './state';
import type { Workbench } from './workbench';

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

const SPACE_ACTIVATES =
  'button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="treeitem"]';

/** Space belongs to a focused control that Space activates; elsewhere it repeats the last command. */
function activatesOnSpace(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest(SPACE_ACTIVATES) !== null;
}

/** The "Which one?" kind of a pick: sketch points and curves count as vertices and edges. */
function candidateKind(h: PickHit): 'face' | 'edge' | 'vertex' | 'body' {
  if (h.kind === 'sketchPoint') return 'vertex';
  if (h.kind === 'sketchCurve') return 'edge';
  return h.kind === 'region' || h.kind === 'handle' ? 'face' : h.kind;
}

export function onKey(wb: Workbench, e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const id = eventBindingId(e);
  if (!id) return;
  const u = wb.ui.get();
  const sketching = u.sketch !== null;
  const cmd = commandFor(wb.input.get(), id, sketching);
  const typing = isTyping(e.target);
  if (!cmd) {
    // Tab: cycle the preselection under a still pointer (focus is on the page, not a control).
    if (e.code === 'Tab' && !sketching && wb.tabCycle(e)) return;
    // Enter ends a spline being drawn (open); closing is a tap on its first point.
    if (sketching && e.key === 'Enter' && !typing && wb.sketch?.finishShape()) {
      e.preventDefault();
      return;
    }
    // Enter while a list field is being picked: done with it, on to the tool's next field.
    if (e.key === 'Enter' && !sketching && !typing && wb.ui.get().picking && !wb.tabHit) {
      e.preventDefault();
      wb.advancePicking();
      return;
    }
    // Enter takes Tab's preselection (the highlighted candidate) as the pick.
    if (e.key === 'Enter' && !sketching && !typing && wb.tabHit) {
      e.preventDefault();
      const hit = wb.tabHit;
      wb.tabHit = null;
      void wb.choose(hit, e.shiftKey);
      return;
    }
    if (sketching && (e.key === 'Delete' || e.key === 'Backspace') && !typing) {
      e.preventDefault();
      wb.sketch?.deleteSelected();
    }
    return;
  }
  // Chords with the platform modifier run even in a text field when they are the file commands;
  // undo / redo belong to the field there.
  const chord = id.startsWith('Mod+');
  switch (cmd.id) {
    case 'undo':
    case 'redo':
      if (typing) return;
      e.preventDefault();
      if (cmd.id === 'redo') wb.redo();
      else wb.undo();
      return;
    case 'save':
      e.preventDefault();
      void wb.exportWren();
      return;
    case 'open':
      e.preventDefault();
      void wb.openFromDisk();
      return;
    case 'palette':
      return; // the shell's command palette handles its own key
  }
  if (typing || chord || e.altKey) return;
  // The drawing route has its own keys; model tools must not fire under it.
  if (u.drawing) return;
  switch (cmd.id) {
    case 'cancel':
      if (!sketching && wb.cancel()) e.preventDefault();
      return;
    case 'repeat':
      // Space on a focused control activates that control (buttons, tree rows, menu items).
      if (activatesOnSpace(e.target)) return;
      e.preventDefault();
      wb.repeatLast();
      return;
    case 'radial':
      e.preventDefault();
      if (!e.repeat && !u.radial) {
        const p = wb.lastPointer ?? wb.canvasCentre();
        wb.patchUi({ radial: { x: p.x, y: p.y, source: 'keyboard', holdCode: e.code } });
      }
      return;
  }
  if (sketching) return; // the sketch toolbar owns the sketch tool keys
  if (cmd.id.startsWith('tool:')) {
    e.preventDefault();
    const tool = cmd.id.slice('tool:'.length) as ModelTool | FeatureTool;
    if (tool === 'sketch') wb.sketchTool();
    else void wb.runTool(tool);
  } else if (cmd.id.startsWith('view:')) {
    const name = cmd.id.slice('view:'.length) as Parameters<TouchViewport['setView']>[0];
    wb.viewport?.setView(name, true);
  }
}

export function setNavigationSettings(
  wb: Workbench,
  navigation: InputSettings['navigation'],
): void {
  wb.input.set((s) => withNavigation(s, navigation));
  wb.viewport?.setNavigation(navigation);
}

export function setKeymapOverrides(wb: Workbench, overrides: KeymapOverrides): void {
  wb.input.set((s) => withKeymap(s, overrides));
}

export function openSettings(wb: Workbench, tab: SettingsTab = 'navigation'): void {
  wb.patchUi({ settings: tab, radial: null, chooser: null });
}

export function closeSettings(wb: Workbench): void {
  wb.patchUi({ settings: null });
}

export function canvasCentre(wb: Workbench): { x: number; y: number } {
  const r = wb.canvas?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
}

export function repeatLast(wb: Workbench): void {
  if (wb.ui.get().sketch) {
    wb.sketch?.repeatTool();
    return;
  }
  const last = wb.ui.get().lastTool;
  if (!last) return;
  if (last === 'sketch') wb.sketchTool();
  else void wb.runTool(last);
}

export function lastCommandLabel(wb: Workbench): string | null {
  if (wb.ui.get().sketch) return wb.sketch?.lastToolLabel() ?? null;
  return wb.ui.get().lastTool;
}

export function radialAction(wb: Workbench, id: string): void {
  wb.patchUi({ radial: null });
  if (id === 'repeat') wb.repeatLast();
  else if (id === 'sketch:finish') wb.sketch?.finish();
  else if (id.startsWith('sketch:')) wb.sketch?.setTool(id.slice(7) as SketchToolId);
  else if (id === 'iso') wb.viewport?.setView('iso', true);
  else if (id === 'folder:add') void wb.addFolder(wb.folderRunOf(wb.treeSelection.get()));
  else wb.bubbleAction(id as BubbleActionId);
}

export async function openRadial(
  wb: Workbench,
  g: { x: number; y: number; pointerType: 'mouse' | 'pen' | 'touch'; pointerId?: number },
  hit: PickHit | null,
  held: boolean,
): Promise<void> {
  const u = wb.ui.get();
  // The selection is set synchronously (the menu's items follow it); its persistent reference
  // resolves in the kernel afterwards. The menu never waits for that round trip (ADR-076).
  if (!u.sketch && hit && !u.selection.some((s) => s.key === hitKey(hit)))
    void wb.track(wb.selectHit(hit, false));
  const r = wb.canvas?.getBoundingClientRect();
  wb.patchUi({
    bubble: null,
    chooser: null,
    radial: {
      x: g.x + (r?.left ?? 0),
      y: g.y + (r?.top ?? 0),
      source: g.pointerType,
      ...(held ? { held: true } : {}),
      ...(g.pointerId !== undefined ? { pointerId: g.pointerId } : {}),
    },
  });
}

export function forgetPick(wb: Workbench): void {
  wb.lastPick = [];
  wb.tabHit = null;
}

export function rememberPick(wb: Workbench, hits: readonly PickHit[]): void {
  wb.lastPick = sortCandidates(
    hits.map((h) => ({
      id: hitKey(h),
      kind: candidateKind(h),
      ...(h.depth !== undefined ? { depth: h.depth } : {}),
      hit: h,
    })),
  );
  wb.tabHit = null;
}

export function tabCycle(wb: Workbench, e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  const onPage = !t || t === document.body || t === wb.canvas || t === wb.canvas?.parentElement;
  if (!onPage || wb.lastPick.length === 0 || wb.ui.get().chooser) return false;
  const ids = wb.lastPick.map((c) => c.id);
  const cur = wb.tabHit ? hitKey(wb.tabHit) : null;
  const next = cyclePreselection(ids, cur, e.shiftKey ? -1 : 1);
  const hit = wb.lastPick.find((c) => c.id === next)?.hit ?? null;
  if (!hit) return false;
  e.preventDefault();
  wb.tabHit = hit;
  wb.setHover(hit);
  return true;
}
