/**
 * Measure (desktop/tablet Inspect tool, phone Measure tab): pick one or two targets, measure them
 * exactly in the kernel (`ModelingApi.measure` on the latest regen), show the result in the
 * MeasurePanel and as viewport markers with an HTML label. On the phone the first measurement
 * boots the kernel (it may still be a viewer of cached meshes).
 */

import type { PickHit } from '@whittle/contracts';
import { type MeasurePick, measureMarkers, measureTargetFor, nextPicks } from '../model/measure';
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
    // Results show in the phone's Measure tab, in the tablet sheet's inspector.
    const snap = this.wb.ui.get().sheetSnap;
    if (this.wb.tier === 'phone')
      this.wb.patchUi({ sheetTab: 'measure', sheetSnap: snap === 'peek' ? 'half' : snap });
    else if (this.wb.tier === 'tablet') this.wb.openSheet('inspector', true);
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
    if (this.wb.tier === 'tablet') this.wb.restoreSheet();
  }

  private toPick(hit: PickHit): MeasurePick {
    return {
      id: `m${++this.ids}`,
      label: this.wb.selectionLabel(hit) ?? 'Point',
      ...measureTargetFor(hit),
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

  /** Picks name mesh ordinals of the geometry they were made on: an edit invalidates them. */
  onRegen(): void {
    const m = this.state();
    if (!m || m.picks.length === 0) return;
    const bodies = new Set(this.wb.regen.get()?.result.bodies.map((b) => b.id));
    if (m.picks.some((p) => 'bodyId' in p.target && !bodies.has(p.target.bodyId))) {
      this.patch({ picks: [], current: null });
      this.sync();
    }
  }
}
