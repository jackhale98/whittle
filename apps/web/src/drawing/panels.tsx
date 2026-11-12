/**
 * The route's panels: each reads the build and the controller and renders one component of
 * `@wren-cad/ui/drawing`. All edits go through the ops modules (document commands).
 */

import type {
  Annotation,
  Drawing,
  DrawingView,
  EvalResult,
  Expr,
  Id,
  SectionView,
  SheetFormat,
} from '@wren-cad/contracts';
import { LATEST_TEMPLATE_VERSION } from '@wren-cad/drawing';
import { Button } from '@wren-cad/ui';
import {
  AnnotationInspector,
  AttentionPanel,
  DrawingExportPanel,
  ImportPanel,
  type LeaderInfo,
  SheetSettings,
  TableInspector,
  TitleBlockEditor,
  ViewInspector,
  ViewsPanel,
} from '@wren-cad/ui/drawing';
import { Ruler } from 'lucide-react';
import {
  attentionRows,
  characteristicChoices,
  datumChoices,
  importRows,
  labelProblem,
  notPromotable,
  problemsOf,
  sourceText,
  titleRows,
  valueText,
  viewRows,
} from './adapters';
import type { DrawingController } from './controller';
import {
  addVertex,
  cutKind,
  moveVertex,
  removeVertex,
  toHalfSection,
  toOffsetSection,
} from './cutline';
import { exportDrawing } from './exports';
import { host } from './host';
import { ratioExpr, scaleFromInput, scaleLabel, viewName } from './model';
import {
  commitImport,
  deleteAnnotation,
  openImport,
  removePlacement,
  startReattach,
  updateAnnotation,
  updatePlacement,
} from './ops-annot';
import { addSheet, deleteSheet, moveViewToSheet, planViewMove } from './ops-sheets';
import { removeTable, updateTable } from './ops-tables';
import {
  addBaseView,
  addIsoView,
  addStandardViews,
  childrenOf,
  removeView,
  updateView,
} from './ops-views';
import type { Built } from './pipeline';
import { printDrawing } from './print';
import type { DrawingUiState } from './state';

type Touch = 'md' | 'touch';

/** Evaluates a scale as typed (`1:2`, `2`, `1/4`) against the drawing's configuration. */
export function evalRatio(b: Built, text: string): EvalResult {
  const t = scaleFromInput(text) ?? text;
  const r = host.evaluate(t, 'scalar', b.main.doc);
  if (r.ok && !(r.value > 0))
    return { ok: false, error: { message: 'A scale must be above zero' } };
  return r;
}

const evalLen = (c: DrawingController, e: Expr): EvalResult => c.wb.evaluate(e, 'length');

function derivedLabel(v: DrawingView, scale: number | undefined, asme: boolean): string {
  if (v.kind === 'section')
    return asme ? `SECTION ${v.letter}-${v.letter}` : `${v.letter}–${v.letter}`;
  if (v.kind === 'detail')
    return asme ? `DETAIL ${v.letter}` : `${v.letter}${scale ? ` (${scaleLabel(scale)})` : ''}`;
  return '';
}

export function ViewPanelBody({ c, b, size }: { c: DrawingController; b: Built; size: Touch }) {
  const sel = c.ui.get().selected;
  const view = sel?.kind === 'view' ? b.drawing.views.find((v) => v.id === sel.id) : undefined;
  if (!view) return null;
  const sv = b.build.views.get(view.id);
  const parent =
    'parentId' in view ? b.drawing.views.find((v) => v.id === view.parentId) : undefined;
  const asme = b.drawing.standard.family === 'asme';
  const put = (next: DrawingView, label: string) => updateView(c, next, label);
  const configs = [
    { id: null as Id | null, name: 'Default' },
    ...(b.part.configurations ?? []).map((k) => ({ id: k.id as Id | null, name: k.name })),
  ];
  const drawingCfg = b.drawing.configurationId ?? null;
  const cfgName = (id: Id | null) =>
    configs.find((k) => k.id === id)?.name ?? 'Missing configuration';
  const own = view.configurationId;
  const missing = typeof own === 'string' && !configs.some((k) => k.id === own);
  const sectionView = view.kind === 'section' ? (view as SectionView) : null;
  const children = childrenOf(b, view.id).length;
  const half = sectionView ? toHalfSection(sectionView.cut, sectionView.look) : null;
  const move = planViewMove(b.drawing, view.id);
  const offset = sectionView ? toOffsetSection(sectionView.cut, sectionView.look) : null;
  return (
    <ViewInspector
      kind={view.kind}
      title={viewName(view)}
      {...(parent ? { parentName: viewName(parent) } : {})}
      sheet={{
        value: view.sheetId,
        options: b.drawing.sheets.map((s) => ({ id: s.id, name: s.name })),
        onChange: (id: Id) => void moveViewToSheet(c, view.id, id),
        ...(move.ok ? (move.note ? { note: move.note } : {}) : { blocked: move.message }),
      }}
      scale={view.scale ?? ''}
      inheritedScale={sv?.ok ? scaleLabel(sv.scale) : '1:1'}
      evaluateScale={(t) => evalRatio(b, t)}
      onScale={(t) => {
        const next = { ...view } as { scale?: Expr };
        if (t === null) delete next.scale;
        else next.scale = scaleFromInput(t) ?? t;
        put(next as DrawingView, 'Change view scale');
      }}
      label={view.label ?? ''}
      derivedLabel={derivedLabel(view, sv?.ok ? sv.scale : undefined, asme)}
      showLabel={
        view.showLabel !== false &&
        (view.showLabel === true || view.kind === 'section' || view.kind === 'detail')
      }
      onLabel={(t) => {
        const next = { ...view } as { label?: string };
        if (t === null) delete next.label;
        else next.label = t;
        put(next as DrawingView, 'Change view label');
      }}
      onShowLabel={(show) => put({ ...view, showLabel: show }, 'Show or hide view label')}
      display={
        sv?.ok
          ? sv.display
          : {
              lines: 'visible',
              tangentEdges: 'off',
              centerMarks: true,
              centerLines: true,
              threads: true,
            }
      }
      onDisplay={(patch) =>
        put({ ...view, display: { ...(view.display ?? {}), ...patch } }, 'Change view display')
      }
      configuration={{
        value: own,
        options: configs,
        drawingName: cfgName(drawingCfg),
        ...(missing ? { missing: true } : {}),
      }}
      onConfiguration={(v) => {
        const next = { ...view } as { configurationId?: Id | null };
        if (v === undefined) delete next.configurationId;
        else next.configurationId = v;
        put(next as DrawingView, 'Change view configuration');
      }}
      {...(view.layout.kind === 'free'
        ? {
            position: { x: view.layout.position[0], y: view.layout.position[1] },
            onPosition: (x: number, y: number) =>
              put(
                { ...view, layout: { kind: 'free', position: [x, y] } } as DrawingView,
                'Move view',
              ),
          }
        : {
            distance: view.layout.distance,
            onDistance: (distance: number) =>
              put({ ...view, layout: { kind: 'aligned', distance } } as DrawingView, 'Move view'),
          })}
      {...(sectionView
        ? {
            section: {
              letter: sectionView.letter,
              look: sectionView.look,
              depth: sectionView.depth ?? 'full',
              aligned: sectionView.layout.kind === 'aligned',
              onLetter: (letter: string) =>
                put({ ...sectionView, letter }, 'Change section letter'),
              onFlip: () =>
                put(
                  { ...sectionView, look: sectionView.look === 'left' ? 'right' : 'left' },
                  'Flip section',
                ),
              onDepth: (depth: 'full' | 'slice') =>
                put({ ...sectionView, depth }, 'Change section depth'),
              cut: {
                kind: cutKind(sectionView.cut),
                points: sectionView.cut.map((p) =>
                  p.kind === 'free'
                    ? { x: p.at[0], y: p.at[1], editable: true }
                    : { x: 0, y: 0, editable: false },
                ),
                // Edits read the cut where they land: two fields committed in a row must not
                // overwrite each other with a build that has not caught up yet.
                onMove: (i: number, axis: 'x' | 'y', value: number) => {
                  const cur = c.view(sectionView.id);
                  const at = cur?.kind === 'section' ? cur.cut[i] : undefined;
                  if (cur?.kind !== 'section' || at?.kind !== 'free') return;
                  const to: [number, number] = axis === 'x' ? [value, at.at[1]] : [at.at[0], value];
                  put({ ...cur, cut: moveVertex(cur.cut, i, to) }, 'Edit cut line');
                },
                onAdd: () => {
                  const cur = c.view(sectionView.id);
                  if (cur?.kind === 'section')
                    put({ ...cur, cut: addVertex(cur.cut) }, 'Add cut vertex');
                },
                onRemove: (i: number) => {
                  const cur = c.view(sectionView.id);
                  if (cur?.kind === 'section')
                    put({ ...cur, cut: removeVertex(cur.cut, i) }, 'Remove cut vertex');
                },
                ...(half
                  ? {
                      onHalf: () => put({ ...sectionView, cut: half }, 'Make half section'),
                    }
                  : {}),
                ...(offset
                  ? {
                      onOffset: () => put({ ...sectionView, cut: offset }, 'Make offset section'),
                    }
                  : {}),
              },
            },
          }
        : {})}
      {...(view.kind === 'base'
        ? {
            rotation: {
              value: view.rotation ?? '',
              evaluate: (e: Expr) => c.wb.evaluate(e, 'angle'),
              onChange: (t: Expr | null) => {
                const next = { ...view } as { rotation?: Expr };
                if (t === null) delete next.rotation;
                else next.rotation = t;
                put(next as DrawingView, 'Rotate view');
              },
            },
          }
        : {})}
      {...(view.kind === 'detail'
        ? {
            detail: {
              letter: view.letter,
              radius: view.radius,
              onRadius: (radius: number) => put({ ...view, radius }, 'Change detail size'),
              ...(view.center.kind === 'free'
                ? {
                    center: { x: view.center.at[0], y: view.center.at[1] },
                    onCenter: (x: number, y: number) =>
                      put({ ...view, center: { kind: 'free', at: [x, y] } }, 'Move detail circle'),
                  }
                : {}),
              onLetter: (letter: string) => put({ ...view, letter }, 'Change detail letter'),
            },
          }
        : {})}
      dependents={children}
      onDelete={() => removeView(c, view.id, 'remove')}
      onDetachAndDelete={() => removeView(c, view.id, 'detach')}
      evaluate={(e) => evalLen(c, e)}
      size={size}
    />
  );
}

export function AnnotationPanelBody({
  c,
  b,
  size,
}: {
  c: DrawingController;
  b: Built;
  size: Touch;
}) {
  const sel = c.ui.get().selected;
  const placement =
    sel?.kind === 'placement' ? b.drawing.placements.find((p) => p.id === sel.id) : undefined;
  if (!placement) return null;
  const a: Annotation | undefined = (b.part.annotations ?? []).find(
    (x) => x.id === placement.annotationId,
  );
  if (!a) return null;
  const res = b.main.resolutions.get(a.id);
  const state = res?.state ?? 'needsAttention';
  const problems = problemsOf(b, a.id);
  const measured =
    // T1: a number only while the annotation resolved; needing attention shows none.
    state === 'ok' && res?.measured !== undefined
      ? a.kind === 'angle'
        ? (res.measured * 180) / Math.PI
        : res.measured
      : undefined;
  const text = valueText(a, res);
  const src = sourceText(b.part, a);
  const leader = leaderInfo(b, placement.id);
  const applies = appliesToInfo(b, a);
  return (
    <AnnotationInspector
      annotation={a}
      placement={placement}
      valueText={text}
      state={state}
      problems={problems}
      {...(src ? { sourceText: src } : {})}
      {...('source' in a && a.source
        ? { readOnlyReason: 'The value is read from the model.' }
        : {})}
      evaluate={(e) => c.wb.evaluate(e)}
      datums={datumChoices(b)}
      characteristics={characteristicChoices(b)}
      datumLabelProblem={(l, own) => labelProblem(b, l, own)}
      {...(measured !== undefined ? { measured } : {})}
      onChange={(next) => updateAnnotation(c, next, 'Edit annotation')}
      onPlacement={(p) => updatePlacement(c, p, 'Move annotation')}
      onRemoveFromView={() => removePlacement(c, placement.id)}
      onDelete={() => deleteAnnotation(c, a.id)}
      onReattach={() => startReattach(c, a.id)}
      {...(leader ? { leader } : {})}
      {...(applies ? { appliesTo: applies } : {})}
      size={size}
    />
  );
}

/** The size dimension a datum or a frame applies to, in words (ADR-094). */
function appliesToInfo(
  b: Built,
  a: Annotation,
): { dimension: string; feature?: string; missing?: boolean } | undefined {
  if ((a.kind !== 'datumFeature' && a.kind !== 'geometricTolerance') || !a.appliesTo)
    return undefined;
  const dim = (b.part.annotations ?? []).find((x) => x.id === a.appliesTo);
  if (!dim) return { dimension: '', missing: true };
  const res = b.main.resolutions.get(dim.id);
  const value = res?.state === 'ok' ? res.value : undefined;
  const n = value !== undefined ? `${Math.round(value * 1000) / 1000} ` : '';
  const what = dim.kind === 'diameter' ? `the Ø${n}diameter` : `the ${n}width`;
  return {
    dimension: what.replace(/ $/, ''),
    ...(a.kind === 'datumFeature'
      ? { feature: dim.kind === 'diameter' ? 'axis' : 'median plane' }
      : {}),
  };
}

/** What a leader placement is attached to, in words, and the length of its line (ADR-094). */
function leaderInfo(b: Built, placementId: Id): LeaderInfo | undefined {
  const pl = b.drawing.placements.find((p) => p.id === placementId);
  const g = b.build.placed.find((p) => p.placementId === placementId)?.leader;
  if (pl?.layout.kind !== 'leader' || !g) return undefined;
  const at = pl.layout.attach;
  const lineLength = g.on
    ? Math.hypot(g.on[1][0] - g.on[0][0], g.on[1][1] - g.on[0][1])
    : undefined;
  const len = lineLength !== undefined ? { lineLength } : {};
  if (at.kind === 'ref') {
    const off = at.t !== undefined && (at.t < 0 || at.t > 1);
    return g.on
      ? { target: off ? 'an extension of its line' : 'its line on this view', ...len }
      : len;
  }
  const other = b.drawing.placements.find((p) => p.id === at.placementId);
  const dim = (b.part.annotations ?? []).find((a) => a.id === other?.annotationId);
  const what = dim ? `the ${dim.kind} dimension` : 'a dimension';
  return at.kind === 'dimensionLine'
    ? { target: `${what}’s line (feature of size)`, ...len }
    : { target: `${what}’s text (feature of size)` };
}

export function TablePanelBody({ c, b, size }: { c: DrawingController; b: Built; size: Touch }) {
  const sel = c.ui.get().selected;
  const table = sel?.kind === 'table' ? b.drawing.tables.find((t) => t.id === sel.id) : undefined;
  if (table?.kind !== 'partProperties') return null;
  return (
    <TableInspector
      table={table}
      evaluate={(e) => c.wb.evaluate(e)}
      onChange={(next, label) => updateTable(c, next, label)}
      onDelete={() => removeTable(c, table.id)}
      size={size}
    />
  );
}

export function ViewsPanelBody({
  c,
  b,
  size,
  reviewOnly,
}: {
  c: DrawingController;
  b: Built;
  size: Touch;
  reviewOnly: boolean;
}) {
  const sheetId = c.sheet()?.id ?? '';
  const sel = c.ui.get().selected;
  const baseIds = b.drawing.views.filter((v) => v.sheetId === sheetId && v.kind === 'base');
  const parentId = sel?.kind === 'view' && b.build.views.get(sel.id)?.ok ? sel.id : baseIds[0]?.id;
  return (
    <ViewsPanel
      views={viewRows(b, sheetId)}
      selectedId={sel?.kind === 'view' ? sel.id : null}
      onSelect={(id) => c.select({ kind: 'view', id })}
      onAddBase={(n) => {
        addBaseView(c, n);
        c.patch({ panel: 'views' });
      }}
      onAddIso={() => {
        addIsoView(c, parentId);
        c.patch({ panel: 'views' });
      }}
      onAddStandard={() => {
        if (parentId) addStandardViews(c, parentId);
        c.patch({ panel: 'views' });
      }}
      canAddDerived={baseIds.length > 0}
      reviewOnly={reviewOnly}
      size={size}
    />
  );
}

export function ImportPanelBody({
  c,
  b,
  ui,
  size,
}: {
  c: DrawingController;
  b: Built;
  ui: DrawingUiState;
  size: Touch;
}) {
  const plan = ui.importPlan;
  if (!plan) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-xs text-fg-muted">
          Place the model’s dimensions and annotations on the views that show them true-length, in
          one step.
        </p>
        <Button
          variant="primary"
          size={size}
          icon={<Ruler className="size-4" />}
          onClick={() => void openImport(c)}
          data-testid="import-open"
        >
          Import model annotations
        </Button>
      </div>
    );
  }
  return (
    <ImportPanel
      rows={importRows(plan, b)}
      checked={ui.importChecked}
      onToggle={(key, on) =>
        c.ui.set((s) => {
          const next = new Set(s.importChecked);
          if (on) next.add(key);
          else next.delete(key);
          return { ...s, importChecked: next };
        })
      }
      onAll={(on) =>
        c.ui.set((s) => ({
          ...s,
          importChecked: new Set(
            on ? plan.candidates.filter((x) => x.placement).map((x) => x.key) : [],
          ),
        }))
      }
      alreadyPlaced={plan.alreadyPlaced.length}
      notPromotable={notPromotable(plan)}
      onPlace={() => commitImport(c)}
      onCancel={() => c.patch({ importPlan: null })}
      size={size}
    />
  );
}

export function AttentionPanelBody({
  c,
  b,
  size,
  selectedKey,
  reviewOnly = false,
}: {
  c: DrawingController;
  b: Built;
  size: Touch;
  selectedKey: string | null;
  /** Phone: review only, so no "Reattach…". */
  reviewOnly?: boolean;
}) {
  const entries = b.build.attention;
  return (
    <AttentionPanel
      rows={attentionRows(b).map((r) => (reviewOnly ? { ...r, reattachable: false } : r))}
      selectedKey={selectedKey}
      size={size}
      onSelect={(key) => {
        const e = entries.find((x) => x.key === key);
        if (!e) return;
        if (e.sheetId && e.sheetId !== c.sheet()?.id) c.patch({ sheetId: e.sheetId });
        if (e.subject.kind === 'annotation' && e.subject.placementId)
          c.ui.set((s) => ({
            ...s,
            selected: { kind: 'placement', id: (e.subject as { placementId: Id }).placementId },
            panel: 'attention',
          }));
        else if (e.subject.kind === 'view')
          c.ui.set((s) => ({
            ...s,
            selected: { kind: 'view', id: (e.subject as { viewId: Id }).viewId },
            panel: 'attention',
          }));
      }}
      onReattach={(key) => {
        const e = entries.find((x) => x.key === key);
        if (e?.subject.kind === 'annotation') startReattach(c, e.subject.annotationId);
      }}
    />
  );
}

export function TitlePanelBody({
  c,
  b,
  size,
  focusSlot,
}: {
  c: DrawingController;
  b: Built;
  size: Touch;
  focusSlot: string | null;
}) {
  const sheet = c.sheet();
  if (!sheet) return null;
  const { rows, unused } = titleRows(b, sheet.id);
  return (
    <TitleBlockEditor
      rows={rows}
      unused={unused}
      focusSlot={focusSlot}
      size={size}
      onEdit={(slot, text) => setTitleField(c, b.drawing, sheet.id, slot, text)}
    />
  );
}

/** Title block text is stored where it already is (the sheet's, else the drawing's). */
export function setTitleField(
  c: DrawingController,
  drawing: Drawing,
  sheetId: Id,
  slot: string,
  text: string | null,
): void {
  const sheet = drawing.sheets.find((s) => s.id === sheetId);
  const onSheet = (sheet?.fields as Record<string, string> | undefined)?.[slot] !== undefined;
  c.apply(
    {
      kind: 'setTitleBlockFields',
      drawingId: drawing.id,
      ...(onSheet ? { sheetId } : {}),
      fields: { [slot]: text },
    },
    'Edit title block',
  );
}

export function SheetPanelBody({ c, b, size }: { c: DrawingController; b: Built; size: Touch }) {
  const sheet = c.sheet();
  if (!sheet) return null;
  const d = b.drawing;
  const configs = [
    { id: null as Id | null, name: 'Default' },
    ...(b.part.configurations ?? []).map((k) => ({ id: k.id as Id | null, name: k.name })),
  ];
  const cfg = d.configurationId ?? null;
  const missing = cfg !== null && !configs.some((k) => k.id === cfg);
  const tpl = d.template;
  return (
    <SheetSettings
      drawingName={d.name}
      onRename={(name) =>
        c.apply({ kind: 'updateDrawing', drawingId: d.id, changes: { name } }, 'Rename drawing')
      }
      family={d.standard.family}
      gps={d.standard.gps}
      surfaceFinish={d.standard.surfaceFinish}
      generalTolerance={d.standard.generalTolerance ?? ''}
      onGeneralTolerance={(t) => {
        const standard = { ...d.standard };
        if (t.trim() === '') delete standard.generalTolerance;
        else standard.generalTolerance = t.trim();
        c.apply(
          { kind: 'updateDrawing', drawingId: d.id, changes: { standard } },
          'Edit general tolerance',
        );
      }}
      projection={d.projection}
      onProjection={(projection) =>
        c.apply(
          { kind: 'updateDrawing', drawingId: d.id, changes: { projection } },
          'Change projection method',
        )
      }
      sheet={{ id: sheet.id, name: sheet.name, format: sheet.format, scale: sheet.scale }}
      sheets={d.sheets.map((s) => ({ id: s.id, name: s.name }))}
      onFormat={(format: SheetFormat) =>
        c.apply(
          { kind: 'updateSheet', drawingId: d.id, sheet: { ...sheet, format } },
          'Change sheet size',
        )
      }
      onSheetScale={(t) =>
        c.apply(
          {
            kind: 'updateSheet',
            drawingId: d.id,
            sheet: { ...sheet, scale: scaleFromInput(t) ?? t },
          },
          'Change sheet scale',
        )
      }
      evaluateScale={(t) => evalRatio(b, t)}
      onAddSheet={() => void addSheet(c)}
      onRemoveSheet={(id) => void deleteSheet(c, id)}
      template={{ id: tpl.id, version: tpl.version, latest: LATEST_TEMPLATE_VERSION[tpl.id] }}
      onReapplyTemplate={() =>
        c.apply(
          {
            kind: 'applyTemplate',
            drawingId: d.id,
            template: { id: tpl.id, version: LATEST_TEMPLATE_VERSION[tpl.id] },
          },
          'Re-apply template',
        )
      }
      configuration={{ value: cfg, options: configs, ...(missing ? { missing: true } : {}) }}
      onConfiguration={(v) =>
        c.apply(
          { kind: 'updateDrawing', drawingId: d.id, changes: { configurationId: v } },
          'Change drawing configuration',
        )
      }
      size={size}
    />
  );
}

export function ExportPanelBody({
  c,
  b,
  ui,
  size,
}: {
  c: DrawingController;
  b: Built;
  ui: DrawingUiState;
  size: Touch;
}) {
  const sheet = c.sheet();
  return (
    <DrawingExportPanel
      sheetName={sheet?.name ?? 'Sheet'}
      sheetCount={b.drawing.sheets.length}
      busy={(ui.exporting as never) ?? null}
      {...(ui.pending
        ? { unavailable: 'The model is updating. Export is available in a moment.' }
        : {})}
      attentionCount={b.build.attention.filter((e) => e.severity === 'attention').length}
      onExport={(format, scope) => void exportDrawing(c, format, scope)}
      onPrint={(scope) => void printDrawing(c, scope)}
      size={size}
    />
  );
}

export { ratioExpr };
