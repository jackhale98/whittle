/**
 * Measure (desktop/tablet Inspect tool, phone Measure tab): pick one or two targets, measure them
 * exactly in the kernel (`ModelingApi.measure` on the latest regen), show the result in the
 * MeasurePanel and as viewport markers with an HTML label. On the phone the first measurement
 * boots the kernel (it may still be a viewer of cached meshes).
 */

import type { PickHit } from '@wren-cad/contracts';
import {
  type MeasurePick,
  measureMarkers,
  measureTargetFor,
  nextPicks,
  pickIdentity,
  remapPicks,
} from '../model/measure';
import type { MeasureUi } from './state';
import type { Workbench } from './workbench';

const MARKERS = 'measure';

export class MeasureTool {
  private seq = 0;
  private ids = 0;

  constructor(private readonly wb: Workbench) {}

  private state(): MeasureUi | null {
    return this.wb.ui.get().measure;
  }

  private patch(p: Partial<MeasureUi>): void {
    this.wb.ui.set((u) => (u.measure ? { ...u, measure: { ...u.measure, ...p } } : u));
  }

  /** Turns measuring on; selected faces/edges/vertices (up to two) are measured right away. */
  async start(hits: readonly PickHit[]): Promise<void> {
    this.wb.pushPull.cancel();
    this.wb.ensureKernel();
    const prev = this.state();
    this.wb.patchUi({
      measure: {
        active: true,
        picks: [],
        current: null,
        results: prev?.results ?? [],
        busy: false,
        error: null,
      },
      prompt: null,
      picking: null,
      featureId: null,
      selection: [],
      bubble: null,
    });
    // Results show in the phone's Measure tab, in the inspector panel elsewhere.
    const snap = this.wb.ui.get().sheetSnap;
    if (this.wb.tier === 'phone')
      this.wb.patchUi({ sheetTab: 'measure', sheetSnap: snap === 'peek' ? 'half' : snap });
    else this.wb.revealInspector(true);
    this.wb.pushHighlights();
    const usable = hits.filter(
      (h) => h.kind === 'face' || h.kind === 'edge' || h.kind === 'vertex',
    );
    if (usable.length) {
      this.patch({ picks: usable.slice(0, 2).map((h) => this.toPick(h)) });
      await this.run();
    }
    this.sync();
  }

  stop(): void {
    this.seq++;
    this.wb.viewport?.setMarkers(MARKERS, null);
    if (!this.state()) return;
    this.wb.patchUi({ measure: null });
    this.wb.restoreSheet();
  }

  private toPick(hit: PickHit): MeasurePick {
    const t = measureTargetFor(hit);
    const mesh = this.wb.regen.get()?.result.bodies.find((b) => b.id === hit.bodyId)?.mesh;
    return {
      id: `m${++this.ids}`,
      label: this.wb.selectionLabel(hit) ?? 'Point',
      ...t,
      ...pickIdentity(t.target, mesh),
    };
  }

  /** A pick in the viewport while measuring: the second one measures the pair, a third restarts. */
  async pick(hit: PickHit): Promise<void> {
    const m = this.state();
    if (!m) return;
    this.patch({ picks: nextPicks(m.picks, this.toPick(hit)), current: null, error: null });
    this.sync();
    await this.run();
  }

  removePick(id: string): Promise<void> {
    const m = this.state();
    if (!m) return Promise.resolve();
    this.patch({ picks: m.picks.filter((p) => p.id !== id), current: null, error: null });
    this.sync();
    return this.wb.track(this.run());
  }

  clear(): void {
    this.seq++;
    this.patch({ picks: [], current: null, results: [], error: null, busy: false });
    this.sync();
  }

  private async run(): Promise<void> {
    const my = ++this.seq;
    const picks = this.state()?.picks ?? [];
    const [a, b] = picks;
    if (!a) {
      this.patch({ busy: false });
      return;
    }
    this.patch({ busy: true });
    const live = await this.wb.whenLive();
    const part = this.wb.part;
    if (my !== this.seq) return;
    if (!live || !part || !this.wb.modeling) {
      this.patch({ busy: false, error: 'The geometry kernel is not available.' });
      return;
    }
    const r = await this.wb.modeling.measure(part.id, a.target, b?.target);
    if (my !== this.seq || !this.state()) return;
    if (r.ok) {
      const results = [...(this.state()?.results ?? []), r.value];
      this.patch({ busy: false, current: r.value, results, error: null });
    } else {
      const hint = r.error.hint ? ` ${r.error.hint}` : '';
      this.patch({ busy: false, current: null, error: `${r.error.message}${hint}` });
    }
    this.sync();
  }

  /** Markers for the picks and the current result. */
  private sync(): void {
    const m = this.state();
    const v = this.wb.viewport;
    if (!v) return;
    v.setMarkers(MARKERS, m ? measureMarkers(m.picks, m.current) : null);
    this.wb.pushHighlights();
  }

  /**
   * Picks name mesh ordinals of the geometry they were made on. After a regen (an edit, an undo)
   * they are found again by persistent name, and picks whose name no longer resolves are dropped,
   * so a measurement never silently moves to another face. A changed pick set is measured again.
   */
  onRegen(): void {
    const m = this.state();
    if (!m || m.picks.length === 0) return;
    const picks = remapPicks(m.picks, this.wb.regen.get()?.result.bodies ?? []);
    const same =
      picks.length === m.picks.length &&
      picks.every((p, i) => {
        const q = m.picks[i];
        const pi = 'index' in p.target ? p.target.index : -1;
        const qi = q && 'index' in q.target ? q.target.index : -1;
        return p.id === q?.id && pi === qi;
      });
    if (same) return;
    this.seq++; // a measurement in flight was for the old ordinals
    this.patch({ picks, current: null, busy: false });
    this.sync();
    if (picks.length > 0) void this.wb.track(this.run());
  }
}
