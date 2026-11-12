/**
 * The drawing route's controller: opens a drawing, keeps its build current as the model, the
 * drawing and the regen change, and runs commands. It owns no document state: every edit is a
 * document command (one undo step), and everything shown is rebuilt from the document.
 */

import type {
  Command,
  Drawing,
  DrawingDefaults,
  DrawingView,
  Id,
  Sheet,
} from '@wren-cad/contracts';
import type { SheetTransient, SheetTransientSpec } from '@wren-cad/ui/drawing';
import { type Observable, observable } from '../app/observable';
import type { Workbench } from '../app/workbench';
import { ensureDrawingSupport } from '../doc/drawing-support';
import { ConfigDataSource, modelKey } from './config-data';
import { host } from './host';
import { createDrawingKernel, type DrawingKernel } from './kernel';
import { newDrawing, ratioExpr, suggestScale, usableArea } from './model';
import { removePlacement } from './ops-annot';
import { recallSheet } from './ops-sheets';
import { removeTable } from './ops-tables';
import { removeView } from './ops-views';
import { type Built, runPipeline } from './pipeline';
import { type DrawingTool, type DrawingUiState, initialDrawingUi, type Selected } from './state';

/** How long the sheet must be left alone before the exact edges are computed. */
const REFINE_DELAY_MS = 400;

const NO_TRANSIENT: SheetTransient = { update() {}, end() {} };

export class DrawingController {
  readonly ui: Observable<DrawingUiState> = observable(initialDrawingUi);
  kernel: DrawingKernel;
  readonly source: ConfigDataSource;
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsub: Array<() => void> = [];
  private toastSeq = 0;
  /** Resolves when the build for the current document has been delivered (tests). */
  private waiters: Array<() => void> = [];
  private building = false;
  private again = false;
  /** Quality of the next build: a model or drawing edit starts at draft. */
  private quality: 'draft' | 'exact' = 'draft';
  /** An export (or a test) is waiting for exact edges: the next builds are exact. */
  private exactRequested = false;
  private refineTimer: ReturnType<typeof setTimeout> | undefined;
  /** Builds delivered so far (tests and the drag perf probe: a drag must not rebuild). */
  builds = 0;
  /** The sheet viewer's drag previews (ADR-094); absent until the viewer mounts (and in tests). */
  viewer: { transient(spec: SheetTransientSpec): SheetTransient } | null = null;
  /** A drag is on: builds wait until it ends, so the sheet under the preview does not change. */
  private held = false;
  private deferred = false;

  constructor(
    readonly wb: Workbench,
    kernel: DrawingKernel = createDrawingKernel(),
  ) {
    this.kernel = kernel;
    this.source = new ConfigDataSource(wb, async (partId, slot) => {
      const port = wb.modeling?.port;
      if (!port?.shapeForDrawing) {
        return {
          ok: false,
          error: { code: 'INTERNAL', message: 'The geometry kernel is still loading.' },
        };
      }
      return port.shapeForDrawing(partId, slot);
    });
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    this.unsub.push(
      this.wb.subscribeDoc(() => {
        this.markStale();
        this.schedule();
      }),
    );
    this.unsub.push(this.wb.regen.subscribe(() => this.schedule()));
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    clearTimeout(this.timer);
    clearTimeout(this.refineTimer);
    this.held = false;
    this.token++;
    this.kernel.dispose();
  }

  /** Starts a drag preview on the sheet: nothing is written and nothing is rebuilt until release. */
  transient(spec: SheetTransientSpec): SheetTransient {
    return this.viewer?.transient(spec) ?? NO_TRANSIENT;
  }

  /** A drag begins: builds wait for it. */
  hold(): void {
    this.held = true;
  }

  /** A drag ended (committed or cancelled): a build that was waiting runs now. */
  resume(): void {
    this.held = false;
    if (this.deferred) {
      this.deferred = false;
      this.schedule(0);
    }
  }

  patch(p: Partial<DrawingUiState>): void {
    this.ui.set((s) => ({ ...s, ...p }));
  }

  // ------------------------------------------------------------------ reading

  get doc() {
    return this.wb.doc;
  }

  drawing(): Drawing | undefined {
    const id = this.ui.get().drawingId;
    return id ? this.doc.drawings.find((d) => d.id === id) : undefined;
  }

  sheet(): Sheet | undefined {
    const d = this.drawing();
    const id = this.ui.get().sheetId;
    return d?.sheets.find((s) => s.id === id) ?? d?.sheets[0];
  }

  built(): Built | null {
    return this.ui.get().built;
  }

  view(id: Id): DrawingView | undefined {
    return this.drawing()?.views.find((v) => v.id === id);
  }

  // ------------------------------------------------------------------ opening

  /** Opens a drawing of the document, or the first-drawing choice when there is none yet. */
  async open(drawingId: Id | null): Promise<void> {
    await ensureDrawingSupport();
    const doc = this.doc;
    const d = drawingId ? doc.drawings.find((x) => x.id === drawingId) : undefined;
    if (!d) {
      this.patch({
        phase: 'missing',
        error: 'This drawing is not in the document.',
        drawingId: null,
        sheetId: null,
        built: null,
        selected: null,
      });
      return;
    }
    this.patch({
      phase: 'drawing',
      drawingId: d.id,
      sheetId: recallSheet(d) ?? d.sheets[0]?.id ?? null,
      selected: null,
      tool: 'select',
      built: null,
      error: null,
      hint: null,
      importPlan: null,
      panel: 'inspector',
    });
    this.schedule(0);
  }

  /** A new drawing of the part: straight away with the project's standard, else the choice first. */
  async openNew(): Promise<void> {
    await ensureDrawingSupport();
    if (this.doc.drawingDefaults) {
      await this.create();
      return;
    }
    this.patch({ phase: 'choose', drawingId: null, sheetId: null, built: null, selected: null });
  }

  /** Deletes the selection: a view (with what derives from it) or a placement (the annotation stays). */
  deleteSelected(): void {
    const sel = this.ui.get().selected;
    if (sel?.kind === 'view') removeView(this, sel.id);
    else if (sel?.kind === 'placement') removePlacement(this, sel.id);
    else if (sel?.kind === 'table') removeTable(this, sel.id);
  }

  /**
   * Creates the first drawing of the part with the project's standard and projection (D10: the
   * choice is explicit and remembered), a template and sheet from the standard, and a front view.
   */
  async create(defaults: DrawingDefaults | null = null): Promise<Id | null> {
    await ensureDrawingSupport();
    const wb = this.wb;
    const doc = wb.doc;
    const part = doc.parts[0];
    if (!part) {
      this.toast('There is no part to draw yet.', 'error');
      return null;
    }
    const chosen = defaults ?? doc.drawingDefaults;
    if (!chosen) {
      this.patch({ phase: 'choose' });
      return null;
    }
    const key = `drawing:new:${host.ulid()}`;
    if (!doc.drawingDefaults || defaults) {
      if (!wb.apply({ kind: 'setDrawingDefaults', defaults: chosen }, 'Set drawing standard', key))
        return null;
    }
    const bounds = this.regenBounds();
    const id = host.ulid();
    const draft = newDrawing({
      id,
      sheetId: host.ulid(),
      name: `${part.name} drawing`,
      partId: part.id,
      defaults: chosen,
      scale: 1,
      ...(part.activeConfigurationId ? { configurationId: part.activeConfigurationId } : {}),
    });
    const area = usableArea((draft.sheets[0] as Sheet).format, draft.template);
    const scale = suggestScale(bounds, area);
    // A front view to start from, placed so its top and side views fit under the projection.
    const w = (bounds.max[0] - bounds.min[0]) * scale;
    const h = (bounds.max[2] - bounds.min[2]) * scale;
    const x = area.min[0] + w / 2 + 8;
    const y = chosen.projection === 'first' ? area.max[1] - h / 2 - 8 : area.min[1] + h / 2 + 8;
    const sheet = { ...(draft.sheets[0] as Sheet), scale: ratioExpr(scale) };
    const drawing: Drawing = {
      ...draft,
      sheets: [sheet],
      views: [
        {
          id: host.ulid(),
          sheetId: sheet.id,
          kind: 'base',
          orientation: { kind: 'named', name: 'front' },
          layout: { kind: 'free', position: [x, y] },
        },
      ],
    };
    if (!wb.apply({ kind: 'addDrawing', drawing }, 'New drawing', key)) return null;
    wb.commit();
    await this.open(id);
    return id;
  }

  regenBounds(): { min: [number, number, number]; max: [number, number, number] } {
    const r = this.wb.regen.get()?.result;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const b of r?.bodies ?? []) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, b.mesh.bbox.min[k] as number);
        max[k] = Math.max(max[k] as number, b.mesh.bbox.max[k] as number);
      }
    }
    return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [100, 100, 100] };
  }

  // ------------------------------------------------------------------ building

  /** Rebuilds soon (coalesced). */
  schedule(delay = 16, exact = false): void {
    if (!this.ui.get().drawingId) return;
    clearTimeout(this.timer);
    clearTimeout(this.refineTimer);
    this.quality = exact || this.exactRequested ? 'exact' : 'draft';
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  /**
   * Resolves when the edges on screen are the exact ones for the model as it is now (HLRBRep_Algo).
   * Export awaits this: a drawing is never exported from the draft.
   */
  async ensureExact(): Promise<void> {
    const have = () => {
      const b = this.ui.get().built;
      return b?.quality === 'exact' && this.isCurrent();
    };
    if (have()) return;
    this.exactRequested = true;
    try {
      this.schedule(0, true);
      await this.settled();
    } finally {
      this.exactRequested = false;
    }
  }

  /** Resolves once the build for the document as it is now has been delivered (or failed). */
  settled(): Promise<void> {
    if (!this.building && !this.timer && !this.again && !this.deferred && !this.ui.get().pending) {
      return Promise.resolve();
    }
    return new Promise((r) => this.waiters.push(r));
  }

  private release(): void {
    if (this.building || this.again) return;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async refresh(): Promise<void> {
    this.timer = undefined;
    if (this.held) {
      this.deferred = true;
      return;
    }
    if (this.building) {
      this.again = true;
      return;
    }
    const id = this.ui.get().drawingId;
    if (!id) return;
    this.building = true;
    const my = ++this.token;
    const asked = this.quality;
    try {
      await ensureDrawingSupport();
      const doc = this.doc;
      const r = await runPipeline(doc, id, this.source, this.kernel, asked);
      if (my !== this.token) return;
      if (this.held) {
        // A drag began while this was being built: the sheet under its preview must not change.
        // The build is made again from the document as it is when the drag ends.
        this.deferred = true;
        return;
      }
      if (r.kind === 'ok') {
        // The doc may have changed while projections ran: build again from that.
        const stale = doc !== this.doc;
        this.builds++;
        this.ui.set((s) => ({
          ...s,
          built: r.built,
          pending: false,
          error: null,
          phase: 'drawing',
          // Kept while the document still has it: a build that started before a sheet was added
          // (or the route switched to it) must not send the route back to the first sheet.
          sheetId:
            s.sheetId &&
            (r.built.drawing.sheets.some((x) => x.id === s.sheetId) ||
              this.drawing()?.sheets.some((x) => x.id === s.sheetId))
              ? s.sheetId
              : (r.built.drawing.sheets[0]?.id ?? null),
        }));
        if (stale) this.again = true;
        if (asked === 'exact') this.patch({ refining: false });
        else if (r.built.quality === 'draft') {
          // Exact output follows when idle (any edit before then starts over at draft).
          this.patch({ refining: true });
          if (!stale) {
            this.refineTimer = setTimeout(() => this.schedule(0, true), REFINE_DELAY_MS);
          }
        }
      } else if (r.kind === 'pending') {
        // Keep showing the last build, marked as not current, and try again when the regen lands.
        this.ui.set((s) => ({ ...s, pending: s.built !== null }));
      } else if (r.kind === 'missing') {
        this.ui.set((s) => ({ ...s, phase: 'missing', error: r.message, built: null }));
      } else {
        this.ui.set((s) => ({ ...s, error: r.message }));
      }
    } catch (e) {
      this.ui.set((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      this.building = false;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      } else this.release();
    }
  }

  // ------------------------------------------------------------------ commands

  /** Applies a document command as one undo step (or coalesced with `key`). */
  apply(command: Command, label: string, key?: string): boolean {
    return this.wb.apply(command, label, key);
  }

  /** Reverts an uncommitted drag group: the state from before the drag, nothing in history. */
  cancelEdit(key: string): boolean {
    return this.wb.cancelEdit(key);
  }

  commit(): void {
    this.wb.commit();
  }

  select(selected: Selected): void {
    this.ui.set((s) => ({
      ...s,
      selected,
      panel: selected && s.panel !== 'attention' && s.panel !== 'import' ? 'inspector' : s.panel,
    }));
  }

  setTool(tool: DrawingTool): void {
    this.ui.set((s) => ({
      ...s,
      tool,
      hint: null,
      reattach: tool === 'reattach' ? s.reattach : null,
    }));
  }

  toast(text: string, tone: 'info' | 'error' = 'info'): void {
    const id = ++this.toastSeq;
    this.patch({ toast: { id, text, tone } });
    setTimeout(() => {
      if (this.ui.get().toast?.id === id) this.patch({ toast: null });
    }, 4500);
  }

  /**
   * A model edit has just been made: until its regen lands, what is on screen is not current and
   * is shown dimmed (a stale value is never shown as the model's, trap T1).
   */
  private markStale(): void {
    const b = this.ui.get().built;
    if (!b || this.ui.get().pending) return;
    const cfg = b.drawing.configurationId ?? null;
    const active = this.wb.part?.activeConfigurationId ?? null;
    if (cfg !== active) return;
    if (modelKey(b.main.doc) !== modelKey(this.wb.viewDoc())) this.patch({ pending: true });
  }

  /** Whether the model behind the last build is the model as it is now. */
  isCurrent(): boolean {
    const b = this.ui.get().built;
    return (
      b !== null && !this.ui.get().pending && modelKey(b.main.doc) === modelKey(this.wb.viewDoc())
    );
  }
}
