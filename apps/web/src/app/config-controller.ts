/**
 * Part configurations in the workbench (M3.7, ADR-074): which configuration is regenerated, the
 * edit scope at the point of edit (trap T1), the table's edits and pastes, the "Changed in all N"
 * notice and the background builds. The workbench owns one of these as `wb.config`.
 *
 * Scope rule (Fusion's, decided per edit, never remembered): editing an inherited value edits
 * Default with the ordinary commands, so every configuration that inherits sees it, and shows an
 * undoable notice; editing an overridden value, or one with the one-shot chip on, writes a
 * `setConfigurationOverrides` for the active configuration.
 */

import type {
  Command,
  ConfigTarget,
  Configuration,
  ConfiguredValue,
  Expr,
  Feature,
  Id,
  Material,
  Part,
  PartProperties,
} from '@wren-cad/contracts';
import {
  applyPatch,
  existsAt,
  type ResolvedConfiguration,
  resolveConfiguration,
  ulid,
} from '@wren-cad/document';
import type { ConfigTableEdit, EditScope, PastePlan } from '@wren-cad/ui';
import { ConfigBuilds } from './config-builds';
import {
  activeIdOf,
  buildTableModel,
  configurationFromEdits,
  inheritCount,
  isMissingActive,
  overrideIn,
  planFeatureEdit,
  type TableModel,
  typedOption,
} from './config-model';
import { type Observable, observable } from './observable';
import type { Workbench } from './workbench';

export interface ConfigUiState {
  /** The configuration table panel is open. */
  panel: boolean;
  /** "Changed in all N configurations" after an edit of an inherited value. */
  notice: { count: number; seq: number } | null;
  /** The table's double-click: the inspector focuses this field of the open feature. */
  focusField: { featureId: Id; path: string; seq: number } | null;
  /** "Export all" is regenerating other configurations in the live slot: input is held. */
  exportingAll: boolean;
}

/** How the last configuration switch performed (budget: 300 ms, PLAN §10). */
export interface SwitchTiming {
  toId: Id | null;
  /** The regen result for the new configuration arrived (ms after the command). */
  regenMs: number;
  /** The new meshes were drawn (ms after the command). */
  renderMs: number;
  /** Every feature came from the regen cache. */
  cached: boolean;
}

export class ConfigController {
  readonly state: Observable<ConfigUiState> = observable<ConfigUiState>({
    panel: false,
    notice: null,
    focusField: null,
    exportingAll: false,
  });
  readonly builds: ConfigBuilds;
  readonly lastSwitch: Observable<SwitchTiming | null> = observable<SwitchTiming | null>(null);
  private memo: { raw: unknown; out: ResolvedConfiguration } | null = null;
  private switching: { id: Id | null; at: number } | null = null;
  private seq = 0;
  /** An inherited-value edit is in progress (previews) and will be announced on commit. */
  private pendingInherited: ConfigTarget | null = null;
  private tableMemo: { raw: unknown; model: TableModel } | null = null;

  constructor(private readonly wb: Workbench) {
    this.builds = new ConfigBuilds(wb);
  }

  // ------------------------------------------------------------------ what is regenerated

  /** The effective document of the active configuration (memoised per stored document). */
  resolved(): ResolvedConfiguration {
    const raw = this.wb.store.getDoc();
    if (this.memo?.raw === raw) return this.memo.out;
    const part = raw.parts[0];
    const out = part ? resolveConfiguration(raw, part.id) : { doc: raw, issues: [] };
    this.memo = { raw, out };
    return out;
  }

  /** `doc` is the regen input for the document as stored now. */
  isCurrent(doc: unknown): boolean {
    return doc === this.resolved().doc;
  }

  get active(): Configuration | undefined {
    const part = this.wb.part;
    const id = activeIdOf(part);
    return id === null ? undefined : part?.configurations?.find((c) => c.id === id);
  }

  get activeName(): string {
    return this.active?.name ?? 'Default';
  }

  /** The feature as the active configuration shows it. */
  effectiveFeature(id: Id): Feature | undefined {
    return this.resolved().doc.parts[0]?.features.find((f) => f.id === id);
  }

  table(lengthUnit: string): TableModel | null {
    const raw = this.wb.store.getDoc();
    if (this.tableMemo?.raw === raw) return this.tableMemo.model;
    const part = raw.parts[0];
    if (!part) return null;
    const model = buildTableModel(raw, part, lengthUnit);
    this.tableMemo = { raw, model };
    return model;
  }

  // ------------------------------------------------------------------ lifecycle hooks

  /** A new regen of the current document arrived (`quality` is the settled one). */
  onSettled(): void {
    this.builds.prune();
    this.builds.request();
  }

  onRegenResult(regenMs: number, cached: boolean): void {
    const s = this.switching;
    if (!s) return;
    this.switching = null;
    const record = (renderMs: number) =>
      this.lastSwitch.set({ toId: s.id, regenMs, renderMs, cached });
    const v = this.wb.viewport;
    if (v) void v.nextFrame().then(() => record(Math.round(performance.now() - s.at)));
    else record(regenMs);
  }

  reset(): void {
    this.builds.reset();
    // An export in progress keeps its hold until its loop really ends (it stops at the next
    // configuration boundary because the document changed).
    this.state.set((s) => ({
      panel: false,
      notice: null,
      focusField: null,
      exportingAll: s.exportingAll,
    }));
    this.pendingInherited = null;
  }

  /** Picks, measurements and tool commits are held while "Export all" uses the live slot. */
  get exportingAll(): boolean {
    return this.state.get().exportingAll;
  }

  /** Aborts the waits of an export in progress (Cancel, timeout): the hold is released. */
  private abortExport: (() => void) | null = null;
  /** Test hook: extra wait before each configuration of "Export all" (ms). */
  exportDelayMs = 0;

  /** Registers the abort of the running export; `null` when it ends. */
  onExportAbort(fn: (() => void) | null): void {
    this.abortExport = fn;
  }

  cancelExport(): void {
    this.abortExport?.();
  }

  /** Resolves once picks are allowed again (immediately when not exporting). */
  whenReleased(): Promise<void> {
    if (!this.exportingAll) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.state.subscribe(() => {
        if (!this.exportingAll) {
          off();
          resolve();
        }
      });
    });
  }

  setExportingAll(on: boolean): void {
    this.state.set((s) => (s.exportingAll === on ? s : { ...s, exportingAll: on }));
  }

  holdHint(): void {
    this.wb.toast('Exporting every configuration: the model is locked for a moment.', 'info');
  }

  /**
   * With the active configuration missing, an edit would silently change Default (trap T2).
   * Edits are refused until the user chooses a configuration.
   */
  private blockedByMissing(announce = true): boolean {
    if (!isMissingActive(this.wb.part)) return false;
    if (announce) {
      this.wb.toast(
        'This configuration needs attention: it no longer exists. Switch to Default or another configuration before editing.',
        'error',
      );
    }
    return true;
  }

  // ------------------------------------------------------------------ switching and managing

  setActive(id: Id | null): void {
    const part = this.wb.part;
    if (!part) return;
    this.switching = { id, at: performance.now() };
    this.wb.apply({ kind: 'setActiveConfiguration', partId: part.id, configurationId: id });
    this.wb.commit();
  }

  /** "New configuration…": from Default or the active configuration (D3), and switch to it. */
  create(name: string, from: 'default' | 'active'): Id | null {
    const part = this.wb.part;
    if (!part) return null;
    const id = ulid();
    const active = activeIdOf(part);
    const src: 'default' | Id = from === 'active' && active !== null ? active : 'default';
    const key = `config:new:${id}`;
    const ok = this.wb.apply(
      { kind: 'addConfiguration', partId: part.id, configuration: { id, name }, from: src },
      `New configuration ${name}`,
      key,
    );
    if (!ok) return null;
    this.switching = { id, at: performance.now() };
    this.wb.apply(
      { kind: 'setActiveConfiguration', partId: part.id, configurationId: id },
      undefined,
      key,
    );
    this.wb.commit();
    return id;
  }

  rename(id: Id, name: string): void {
    const part = this.wb.part;
    if (!part) return;
    this.wb.apply({ kind: 'renameConfiguration', partId: part.id, configurationId: id, name });
    this.wb.commit();
  }

  remove(id: Id): void {
    const part = this.wb.part;
    if (!part) return;
    this.wb.apply({ kind: 'removeConfiguration', partId: part.id, configurationId: id });
    this.wb.commit();
  }

  openPanel(open = true): void {
    this.state.set((s) => ({ ...s, panel: open }));
  }

  dismissNotice(): void {
    this.state.set((s) => (s.notice ? { ...s, notice: null } : s));
  }

  /** The table's double-click: open the feature in the inspector with that field focused. */
  jumpToField(featureId: Id, path: string): void {
    this.wb.selectFeature(featureId);
    this.state.set((s) => ({ ...s, focusField: { featureId, path, seq: ++this.seq } }));
  }

  clearFocusField(): void {
    this.state.set((s) => (s.focusField ? { ...s, focusField: null } : s));
  }

  // ------------------------------------------------------------------ edit scope

  private announce(target: ConfigTarget | null): void {
    const part = this.wb.part;
    if (!target || !part || !this.active) return;
    const count = inheritCount(part, target);
    if (count < 2) return;
    this.state.set((s) => ({ ...s, notice: { count, seq: ++this.seq } }));
  }

  private overrideCommand(
    edits: { target: ConfigTarget; value?: ConfiguredValue | Material | null }[],
  ): Command | null {
    const part = this.wb.part;
    const id = this.active?.id;
    if (!part || id === undefined || edits.length === 0) return null;
    return {
      kind: 'setConfigurationOverrides',
      partId: part.id,
      edits: edits.map((e) => ({
        configurationId: id,
        target: e.target,
        ...(e.value !== undefined ? { value: e.value } : {}),
      })),
    };
  }

  /** The inspector changed a feature as the active configuration shows it. */
  updateFeature(next: Feature, mode: 'commit' | 'preview', chip: boolean): void {
    const wb = this.wb;
    const part = wb.part;
    if (!part) return;
    if (this.blockedByMissing(mode === 'commit')) return;
    const raw = part.features.find((f) => f.id === next.id);
    const eff = this.effectiveFeature(next.id);
    if (!raw || !eff || !this.active) {
      wb.updateFeatureRaw(next, mode);
      return;
    }
    const plan = planFeatureEdit(raw, eff, next, this.active, chip);
    const key = `edit:${next.id}`;
    if (plan.defaultFeature) {
      wb.apply(
        { kind: 'updateFeature', partId: part.id, featureId: raw.id, feature: plan.defaultFeature },
        undefined,
        key,
      );
    }
    const ov = this.overrideCommand(
      plan.overrides.map((o) => ({
        target: { kind: 'field', featureId: raw.id, path: o.path },
        ...(o.value !== undefined ? { value: o.value } : {}),
      })),
    );
    if (ov) wb.apply(ov, undefined, key);
    if (plan.inherited) this.pendingInherited = plan.inherited;
    if (mode === 'commit') {
      wb.commit();
      const t = this.pendingInherited;
      this.pendingInherited = null;
      this.announce(t);
    }
  }

  /** Suppress or unsuppress a feature in the chosen scope (tree menu). */
  suppress(featureId: Id, suppressed: boolean, scope: 'configuration' | 'all'): void {
    const wb = this.wb;
    const part = wb.part;
    const cfg = this.active;
    if (!part || this.blockedByMissing()) return;
    const target: ConfigTarget = { kind: 'suppressed', featureId };
    const key = `suppress:${featureId}`;
    const rawState = part.features.find((f) => f.id === featureId)?.suppressed === true;
    if (scope === 'configuration' && cfg) {
      const cmd = this.overrideCommand([
        { target, ...(suppressed === rawState ? {} : { value: suppressed }) },
      ]);
      if (cmd) wb.apply(cmd, undefined, key);
      wb.commit();
      return;
    }
    // In all configurations: the active one follows too (its own override is cleared).
    if (cfg && overrideIn(cfg, target).has) {
      const clear = this.overrideCommand([{ target }]);
      if (clear) wb.apply(clear, undefined, key);
    }
    wb.apply({ kind: 'setSuppressed', partId: part.id, featureId, suppressed }, undefined, key);
    wb.commit();
    this.announce(target);
  }

  resetSuppression(featureId: Id): void {
    this.resetOverride({ kind: 'suppressed', featureId });
  }

  /** "Reset to default" on an override marker. */
  resetOverride(target: ConfigTarget): void {
    const cmd = this.overrideCommand([{ target }]);
    if (!cmd) return;
    this.wb.apply(cmd);
    this.wb.commit();
  }

  /** The Params tab: an expression edit, in the scope the component decided. */
  updateParam(
    paramId: Id,
    patch: { name?: string; expr?: Expr; description?: string },
    scope?: EditScope,
  ): void {
    const wb = this.wb;
    if (patch.expr !== undefined && this.blockedByMissing()) return;
    if (patch.expr !== undefined && scope === 'configuration') {
      // Typed back to Default's value: the override is cleared, overrides stay sparse.
      const base = wb.doc.params.find((p) => p.id === paramId)?.expr;
      const same = base !== undefined && base.trim() === patch.expr.trim();
      const cmd = this.overrideCommand([
        { target: { kind: 'param', paramId }, ...(same ? {} : { value: patch.expr }) },
      ]);
      // Never refit: an override must not write Default's sketch geometry. An open sketch redraws
      // from the solve as display state (SketchSession.onDocChange).
      if (cmd) wb.apply(cmd);
      wb.commit();
      return;
    }
    wb.applyRefit({ kind: 'updateParam', paramId, ...patch });
    if (patch.expr !== undefined) this.announce({ kind: 'param', paramId });
  }

  setMaterial(material: Material | null, scope?: EditScope): void {
    const wb = this.wb;
    const part = wb.part;
    if (!part || this.blockedByMissing()) return;
    if (scope === 'configuration') {
      const cmd = this.overrideCommand([{ target: { kind: 'material' }, value: material }]);
      if (cmd) wb.apply(cmd);
      wb.commit();
      wb.syncViewport();
      return;
    }
    wb.apply({ kind: 'setMaterial', partId: part.id, material });
    wb.commit();
    wb.syncViewport();
    this.announce({ kind: 'material' });
  }

  setProperties(patch: PartProperties, scope?: EditScope): void {
    const wb = this.wb;
    const part = wb.part;
    if (!part || this.blockedByMissing()) return;
    if (scope === 'configuration') {
      const cmd = this.overrideCommand(
        (Object.entries(patch) as [keyof PartProperties, string][]).map(([key, value]) => ({
          target: { kind: 'property', key },
          value,
        })),
      );
      if (cmd) wb.apply(cmd);
      wb.commit();
      return;
    }
    const merged: PartProperties = { ...part.properties, ...patch };
    for (const k of Object.keys(merged) as (keyof PartProperties)[]) {
      if (merged[k] === '' || merged[k] === undefined) delete merged[k];
    }
    wb.apply({ kind: 'setPartProperties', partId: part.id, properties: merged });
    wb.commit();
    const first = Object.keys(patch)[0] as keyof PartProperties | undefined;
    if (first) this.announce({ kind: 'property', key: first });
  }

  // ------------------------------------------------------------------ the table

  /** Commands for one table edit; `null` when it cannot apply. */
  private tableCommands(model: TableModel, e: ConfigTableEdit): Command[] {
    const part = this.wb.part;
    if (!part) return [];
    const t = e.target;
    const value =
      t.kind === 'field' && e.value !== undefined ? typedOption(model, t, e.value) : e.value;
    if (e.configurationId !== null) {
      const cmd: Command = {
        kind: 'setConfigurationOverrides',
        partId: part.id,
        edits: [
          {
            configurationId: e.configurationId,
            target: t,
            ...(value !== undefined ? { value } : {}),
          },
        ],
      };
      return [cmd];
    }
    // Default: the ordinary commands, which every inheriting configuration sees.
    if (value === undefined) return [];
    switch (t.kind) {
      case 'param':
        return [{ kind: 'updateParam', paramId: t.paramId, expr: String(value) }];
      case 'field': {
        const f = part.features.find((x) => x.id === t.featureId);
        if (!f) return [];
        try {
          const op = existsAt(f, t.path)
            ? ({ op: 'replace', path: t.path, value } as const)
            : ({ op: 'add', path: t.path, value } as const);
          const feature = applyPatch(f, [op]).doc;
          return [{ kind: 'updateFeature', partId: part.id, featureId: f.id, feature }];
        } catch {
          return [];
        }
      }
      case 'suppressed':
        return [
          {
            kind: 'setSuppressed',
            partId: part.id,
            featureId: t.featureId,
            suppressed: value === true,
          },
        ];
      case 'material':
        return [{ kind: 'setMaterial', partId: part.id, material: value as Material | null }];
      case 'color': {
        const c = String(value ?? '');
        return [
          {
            kind: 'patch',
            ops:
              c === ''
                ? part.color === undefined
                  ? []
                  : [{ op: 'remove', path: '/parts/0/color' }]
                : [
                    {
                      op: part.color === undefined ? 'add' : 'replace',
                      path: '/parts/0/color',
                      value: c,
                    },
                  ],
          },
        ];
      }
      case 'property': {
        const merged: PartProperties = { ...part.properties, [t.key]: String(value) };
        if (merged[t.key] === '') delete merged[t.key];
        return [{ kind: 'setPartProperties', partId: part.id, properties: merged }];
      }
    }
  }

  /** Cell edits from the table (one cell, or a reset). */
  applyTableEdits(edits: readonly ConfigTableEdit[], lengthUnit: string): void {
    const model = this.table(lengthUnit);
    if (!model) return;
    const key = `table:${++this.seq}`;
    let any = false;
    for (const e of edits) {
      for (const c of this.tableCommands(model, e)) {
        if (this.wb.apply(c, undefined, key)) any = true;
      }
    }
    this.wb.commit();
    if (any) this.wb.syncViewport();
  }

  /** A pasted block: one undo step; unknown configurations are created first. */
  applyPaste(plan: PastePlan, lengthUnit: string): void {
    const wb = this.wb;
    const part = wb.part;
    const model = this.table(lengthUnit);
    if (!part || !model) return;
    const key = `paste:${++this.seq}`;
    const ids = new Map<string, Id>();
    for (const name of plan.create) {
      const id = ulid();
      ids.set(name.toLowerCase(), id);
      const edits = plan.edits
        .filter((e) => e.row.kind === 'new' && e.row.name.toLowerCase() === name.toLowerCase())
        .map((e) => ({
          target: e.target,
          ...(e.value !== undefined
            ? { value: e.target.kind === 'field' ? typedOption(model, e.target, e.value) : e.value }
            : {}),
        }));
      const configuration = configurationFromEdits(id, name, edits);
      wb.apply(
        { kind: 'addConfiguration', partId: part.id, configuration },
        `Paste ${plan.create.length} configuration${plan.create.length === 1 ? '' : 's'}`,
        key,
      );
    }
    for (const e of plan.edits) {
      if (e.row.kind === 'new') continue;
      const id = e.row.kind === 'default' ? null : e.row.id;
      const edit: ConfigTableEdit = {
        configurationId: id,
        target: e.target,
        ...(e.value !== undefined ? { value: e.value } : {}),
      };
      for (const c of this.tableCommands(model, edit))
        wb.apply(c, 'Paste into configurations', key);
    }
    wb.commit();
    wb.syncViewport();
  }

  /** Part as stored (for table and panels). */
  get part(): Part | null {
    return this.wb.part;
  }
}
