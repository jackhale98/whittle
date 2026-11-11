/**
 * The background rebuild-all check of part configurations (M3.7, ADR-074, research P0 8).
 *
 * After the active configuration's regen has settled, every other configuration is regenerated in
 * its own `config:<id>` slot, one at a time and on idle, to learn its status (OK / failed / needs
 * attention) and mass. Results are cached by the hash of the resolved values (`valueKey`), so a
 * configuration is rebuilt only when what it resolves to changed. Nothing here runs on save
 * (trap T6) and none of it touches the live model or the viewport: only a summary is kept, the
 * meshes are dropped.
 */

import type { Id, WrenDoc } from '@wren-cad/contracts';
import { resolveConfiguration } from '@wren-cad/document';
import type { ConfigStatus } from '@wren-cad/ui';
import { defaultIdle } from '../model/modeling';
import {
  activeIdOf,
  configStatusOf,
  isMissingActive,
  keyOf,
  type MassSummaryView,
  mergeIssueStatuses,
  slotOf,
  summarizeMass,
  valueKey,
} from './config-model';
import { type Observable, observable } from './observable';
import type { Workbench } from './workbench';

export interface BuildEntry {
  /** `valueKey` of the resolved document this was built for, plus its issues. */
  hash: string;
  status: ConfigStatus;
  message?: string;
  mass?: MassSummaryView;
  /** Time of the regen call (ms). */
  ms: number;
}

export interface BuildsView {
  entries: Readonly<Record<string, BuildEntry>>;
  /** Key of the configuration being built right now. */
  building: string | null;
}

const hashOf = (doc: WrenDoc, partId: Id, id: Id | null): { hash: string; issues: string[] } => {
  const r = resolveConfiguration(doc, partId, id);
  return { hash: valueKey(r.doc), issues: r.issues.map((i) => i.reason) };
};

export class ConfigBuilds {
  readonly view: Observable<BuildsView> = observable<BuildsView>({ entries: {}, building: null });
  private token = 0;
  private cancelIdle: (() => void) | null = null;
  private running = 0;
  private hashes = new WeakMap<WrenDoc, Map<string, string>>();
  private waiters: Array<() => void> = [];

  constructor(private readonly wb: Workbench) {}

  /** A build is scheduled or running. */
  get pending(): boolean {
    return this.cancelIdle !== null || this.running > 0;
  }

  /** The current hash of a configuration of the open document (memoised per document). */
  currentHash(doc: WrenDoc, id: Id | null): string | undefined {
    const part = doc.parts[0];
    if (!part) return undefined;
    let m = this.hashes.get(doc);
    if (!m) {
      m = new Map();
      this.hashes.set(doc, m);
    }
    const k = keyOf(id);
    let h = m.get(k);
    if (h === undefined) {
      const x = hashOf(doc, part.id, id);
      h = `${x.hash}|${x.issues.join('|')}`;
      m.set(k, h);
    }
    return h;
  }

  /** The entry for a configuration if it is still current for `doc`, else `undefined`. */
  entry(doc: WrenDoc, id: Id | null): BuildEntry | undefined {
    const e = this.view.get().entries[keyOf(id)];
    return e && e.hash === this.currentHash(doc, id) ? e : undefined;
  }

  /** Stops what is scheduled (an edit is coming); a build in flight finishes and is kept. */
  cancel(): void {
    this.token++;
    this.cancelIdle?.();
    this.cancelIdle = null;
  }

  /** The active configuration has settled: rebuild the others when idle. */
  request(): void {
    this.cancel();
    const part = this.wb.part;
    if (!part || (part.configurations?.length ?? 0) === 0) {
      this.release();
      return;
    }
    const t = this.token;
    this.cancelIdle = defaultIdle(() => {
      this.cancelIdle = null;
      void this.run(t);
    });
  }

  /** Resolves when no build is scheduled or running. */
  whenSettled(): Promise<void> {
    if (!this.pending) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private release(): void {
    if (this.pending) return;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  private set(key: string, entry: BuildEntry | null, building: string | null): void {
    this.view.set((v) => {
      const entries = { ...v.entries };
      if (entry) entries[key] = entry;
      return { entries, building };
    });
  }

  private async run(t: number): Promise<void> {
    this.running++;
    try {
      const wb = this.wb;
      const modeling = wb.modeling;
      if (!modeling || !wb.loop) return;
      await wb.loop.whenIdle();
      for (const id of this.targets()) {
        if (t !== this.token) return;
        const doc = wb.doc;
        const part = doc.parts[0];
        if (!part) return;
        const key = keyOf(id);
        const want = this.currentHash(doc, id);
        if (this.view.get().entries[key]?.hash === want) continue;
        const resolved = resolveConfiguration(doc, part.id, id);
        this.set(key, null, key);
        const started = performance.now();
        let entry: BuildEntry;
        try {
          const attachments = Object.fromEntries(
            wb.attachmentsFor(resolved.doc).map((a) => [a.path, a.bytes] as const),
          );
          const result = await modeling.port.regenerate({
            doc: resolved.doc,
            partId: part.id,
            quality: 'coarse',
            massProperties: true,
            slot: slotOf(id),
            ...(Object.keys(attachments).length ? { attachments } : {}),
          });
          const names = new Map(part.features.map((f) => [f.id, f.name]));
          const name =
            id === null ? 'Default' : (part.configurations?.find((c) => c.id === id)?.name ?? '');
          const statuses = mergeIssueStatuses(result.features, resolved.issues, name);
          const s = configStatusOf(statuses, resolved.issues, (f) => names.get(f) ?? f);
          const mass = summarizeMass(result.bodies);
          entry = {
            hash: want ?? '',
            status: s.status,
            ...(s.message ? { message: s.message } : {}),
            ...(mass ? { mass } : {}),
            ms: Math.round(performance.now() - started),
          };
        } catch (e) {
          entry = {
            hash: want ?? '',
            status: 'failed',
            message: e instanceof Error ? e.message : 'The build failed.',
            ms: Math.round(performance.now() - started),
          };
        }
        this.set(key, entry, null);
        // The summary is cached: release the slot's shapes at once (iPad memory, PLAN §10).
        void modeling.port.closePart(part.id, slotOf(id)).catch(() => {});
        // Let the live model go first if it asked for the worker meanwhile.
        await wb.loop?.whenIdle();
      }
    } finally {
      this.running--;
      this.view.set((v) => (v.building === null ? v : { ...v, building: null }));
      this.release();
    }
  }

  /** Everything but the active configuration, Default first. A missing active id has no build. */
  private targets(): (Id | null)[] {
    const part = this.wb.part;
    if (!part) return [];
    const active = activeIdOf(part);
    const all: (Id | null)[] = [null, ...(part.configurations ?? []).map((c) => c.id)];
    return all.filter((id) => id !== active || isMissingActive(part));
  }

  /** Drops entries of configurations that are gone. */
  prune(): void {
    const part = this.wb.part;
    const keep = new Set([keyOf(null), ...(part?.configurations ?? []).map((c) => c.id)]);
    this.view.set((v) => {
      const gone = Object.keys(v.entries).filter((k) => !keep.has(k));
      if (gone.length === 0) return v;
      const entries = { ...v.entries };
      for (const k of gone) delete entries[k];
      return { ...v, entries };
    });
  }

  /** A new document: forget everything. */
  reset(): void {
    this.cancel();
    this.view.set({ entries: {}, building: null });
  }
}
