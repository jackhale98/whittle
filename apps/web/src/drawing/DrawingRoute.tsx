/**
 * The drawing route (PLAN M4): a full-screen, lazily loaded view over the model. It shows the
 * sheet of one drawing, rebuilt from the document, the regen and the drawing kernel; every edit
 * is a document command. Nothing here is modal: tools act on the sheet, values are typed inline,
 * and panels dock beside or under it.
 */

import type { Vec2 } from '@wren-cad/contracts';
import { standardPreset } from '@wren-cad/drawing';
import { DRAWING_FONT_FAMILY, drawingFontUrl } from '@wren-cad/drawing/font';
import { svgModel } from '@wren-cad/drawing/svg';
import { Button, PromptChip } from '@wren-cad/ui';
import type { DrawingToolId } from '@wren-cad/ui/drawing';
import {
  ConfigBadge,
  DrawingShell,
  DrawingToolbar,
  InlineCellEditor,
  SheetViewer,
  type SheetViewerApi,
  StandardChoice,
  sourceKey,
} from '@wren-cad/ui/drawing';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';
import { titleRows } from './adapters';
import { DrawingController } from './controller';
import { beginInteraction, currentSheet, nudgeText, viewHit } from './interact';
import { SheetOverlay } from './Overlay';
import { openImport } from './ops-annot';
import { addPartPropertiesTable } from './ops-tables';
import {
  AnnotationPanelBody,
  AttentionPanelBody,
  ExportPanelBody,
  ImportPanelBody,
  SheetPanelBody,
  setTitleField,
  TablePanelBody,
  TitlePanelBody,
  ViewPanelBody,
  ViewsPanelBody,
} from './panels';
import { printDrawing } from './print';
import type { DrawingPanel, DrawingTool } from './state';
import { installDrawingHooks } from './test-hooks';

const FONT_STYLE_ID = 'wren-drawing-font';
function useDrawingFont(): void {
  useEffect(() => {
    if (document.getElementById(FONT_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = FONT_STYLE_ID;
    // Self-hosted (cross-origin isolation): the TTF is an asset of this build.
    s.textContent = `@font-face{font-family:${DRAWING_FONT_FAMILY};src:url(${drawingFontUrl()}) format("truetype");font-display:swap}`;
    document.head.append(s);
  }, []);
}

const TOOL_BY_ID: Partial<Record<DrawingToolId, DrawingTool>> = {
  select: 'select',
  section: 'section',
  detail: 'detail',
  dimension: 'dimension',
  angle: 'angle',
  ordinate: 'ordinate',
  chamfer: 'chamfer',
  datum: 'datum',
  gdt: 'gdt',
  finish: 'finish',
  note: 'note',
};

const PROMPTS: Partial<Record<DrawingTool, string>> = {
  section: 'Drag a cut line across a view',
  detail: 'Drag a circle around the detail on a view',
  dimension:
    'Pick a circle, two edges (parallel: distance, meeting: angle), or one edge twice for its length',
  angle: 'Pick the first of two edges that meet',
  ordinate: 'Pick the origin: an edge or a circle',
  chamfer: 'Pick an edge of the chamfer',
  datum: 'Pick the edge the datum is on',
  gdt: 'Pick the edge the tolerance applies to',
  finish: 'Pick the edge the surface finish is on',
  note: 'Pick the edge the note points at',
  reattach: 'Pick the geometry again',
};

export interface DrawingRouteProps {
  wb: Workbench;
  /** The drawing to open; null = a new drawing of the part. */
  id: string | null;
  tier: 'desktop' | 'tablet' | 'phone';
  onClose(): void;
}

export default function DrawingRoute({ wb, id, tier, onClose }: DrawingRouteProps) {
  useDrawingFont();
  const [controller] = useState(() => new DrawingController(wb));
  const c = controller;
  const ui = useObservable(c.ui);
  useSyncExternalStore(wb.subscribeDoc, wb.getDoc);
  const viewer = useRef<SheetViewerApi>(null);
  const hoverRef = useRef<number | null>(null);
  const touch = tier !== 'desktop';
  const size = touch ? 'touch' : 'md';
  const reviewOnly = tier === 'phone';

  useEffect(() => {
    // Drag previews are drawn by the viewer straight onto the sheet (ADR-094).
    c.viewer = { transient: (spec) => (viewer.current as SheetViewerApi).transient(spec) };
    c.start();
    installDrawingHooks(c);
    void (id ? c.open(id) : c.openNew());
    return () => {
      c.viewer = null;
      c.dispose();
    };
  }, [c, id]);

  const b = ui.built;
  const sheet = c.sheet();
  const composed = currentSheet(c);

  // The sheet as SVG, rebuilt when the build changes.
  const model = useMemo(
    () => (b && composed ? svgModel(composed.list, b.drawing.style, { paper: 'none' }) : null),
    [b, composed],
  );

  const selectedKeys = useMemo(() => {
    const s = ui.selected;
    if (!s) return new Set<string>();
    if (s.kind === 'view') return new Set([`view:${s.id}`]);
    if (s.kind === 'placement') return new Set([`placement:${s.id}`]);
    if (s.kind === 'note') return new Set([`note:${s.id}`]);
    if (s.kind === 'table') return new Set([`table:${s.id}`]);
    return new Set([`titleBlock:${s.slot}`]);
  }, [ui.selected]);

  // ---- choose / missing -------------------------------------------------------------------
  if (ui.phase === 'choose') {
    return (
      <div className="flex h-full flex-col bg-bg text-fg" data-testid="drawing-choose">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-2">
          <Button variant="ghost" size={size} onClick={onClose} data-testid="drawing-back">
            Back to the model
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-4">
          <StandardChoice
            size={size}
            {...(wb.part ? { partName: wb.part.name } : {})}
            onConfirm={({ family, projection }) => {
              void c.create({ standard: standardPreset(family), projection });
            }}
          />
        </div>
      </div>
    );
  }
  if (ui.phase === 'missing') {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg"
        data-testid="drawing-missing"
        role="alert"
      >
        <TriangleAlert className="size-8 text-warning-text" aria-hidden />
        <p className="text-sm font-semibold">
          {ui.error ?? 'This drawing is not in the document.'}
        </p>
        <Button variant="secondary" size={size} onClick={onClose}>
          Back to the model
        </Button>
      </div>
    );
  }

  const readOnly = reviewOnly;
  const pendingNote = ui.pending ? 'Updating from the model…' : null;

  // ---- panels ------------------------------------------------------------------------------
  const attentionN = b ? b.build.attention.filter((e) => e.severity === 'attention').length : 0;
  const panelId: DrawingPanel = ui.panel;
  const selectedKey = ui.selected?.kind === 'placement' ? ui.selected.id : null;
  const inspector = b ? (
    ui.selected?.kind === 'view' ? (
      <ViewPanelBody c={c} b={b} size={size} />
    ) : ui.selected?.kind === 'placement' ? (
      <AnnotationPanelBody c={c} b={b} size={size} />
    ) : ui.selected?.kind === 'table' ? (
      <TablePanelBody c={c} b={b} size={size} />
    ) : ui.selected?.kind === 'cell' ? (
      <TitlePanelBody c={c} b={b} size={size} focusSlot={ui.selected.slot} />
    ) : (
      <div
        className="flex flex-col gap-2 px-4 pb-4 text-xs text-fg-muted"
        data-testid="inspector-empty"
      >
        <p>Select a view or an annotation to edit it.</p>
        <p>
          Drag a view to move it. Select one and drag an arrow out of its edge to add a view that
          stays aligned.
        </p>
      </div>
    )
  ) : null;

  const panels = b
    ? [
        ...(readOnly ? [] : [{ id: 'inspector', label: 'Inspector', content: inspector }]),
        {
          id: 'views',
          label: 'Views',
          content: <ViewsPanelBody c={c} b={b} size={size} reviewOnly={readOnly} />,
        },
        ...(readOnly
          ? []
          : [
              {
                id: 'import',
                label: 'Import',
                content: <ImportPanelBody c={c} b={b} ui={ui} size={size} />,
              },
            ]),
        {
          id: 'attention',
          label: 'Attention',
          badge: attentionN,
          tone: 'danger' as const,
          content: (
            <AttentionPanelBody
              c={c}
              b={b}
              size={size}
              selectedKey={selectedKey}
              reviewOnly={readOnly}
            />
          ),
        },
        ...(readOnly
          ? []
          : [
              {
                id: 'titleblock',
                label: 'Title block',
                content: <TitlePanelBody c={c} b={b} size={size} focusSlot={null} />,
              },
              { id: 'sheet', label: 'Sheet', content: <SheetPanelBody c={c} b={b} size={size} /> },
            ]),
        {
          id: 'export',
          label: 'Export',
          content: <ExportPanelBody c={c} b={b} ui={ui} size={size} />,
        },
      ]
    : [
        {
          id: 'inspector',
          label: 'Drawing',
          content: <p className="px-4 text-xs text-fg-muted">Building the drawing…</p>,
        },
      ];
  const activePanel = panels.some((p) => p.id === panelId)
    ? panelId
    : (panels[0]?.id ?? 'inspector');

  // ---- tools -------------------------------------------------------------------------------
  const activeTool: DrawingToolId | null =
    ui.tool === 'reattach' ? null : ((ui.tool as DrawingToolId) ?? 'select');
  const disabledTools: Partial<Record<DrawingToolId, string>> = {};
  if (!b || (b.drawing.views.length === 0 && true)) {
    for (const t of [
      'section',
      'detail',
      'dimension',
      'angle',
      'ordinate',
      'chamfer',
      'datum',
      'gdt',
      'finish',
      'note',
    ] as const)
      disabledTools[t] = 'Add a view first';
  }
  const onTool = (t: DrawingToolId) => {
    if (t === 'views') c.patch({ panel: 'views' });
    else if (t === 'import') void openImport(c);
    else if (t === 'table') addPartPropertiesTable(c);
    else {
      const tool = TOOL_BY_ID[t];
      if (tool) c.setTool(ui.tool === tool && tool !== 'select' ? 'select' : tool);
    }
  };

  const hintText = ui.hint?.text ?? (ui.tool !== 'select' ? PROMPTS[ui.tool] : undefined);

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): boolean | undefined => {
    if (e.key === 'Escape') {
      if (ui.tool !== 'select' || ui.hint) c.setTool('select');
      else c.select(null);
      e.preventDefault();
      return true;
    }
    // The selected dimension's text moves with the arrow keys (ADR-094): along its line, or above,
    // inline and below it; Shift steps 5 mm.
    if (
      ui.selected?.kind === 'placement' &&
      !readOnly &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key.startsWith('Arrow')
    ) {
      const arrow: Vec2 =
        e.key === 'ArrowLeft'
          ? [-1, 0]
          : e.key === 'ArrowRight'
            ? [1, 0]
            : e.key === 'ArrowUp'
              ? [0, 1]
              : [0, -1];
      e.preventDefault();
      nudgeText(c, ui.selected.id, arrow, e.shiftKey);
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selected && !readOnly) {
      e.preventDefault();
      c.deleteSelected();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p') {
      // The browser's own print would print the app around the sheet: print the sheet instead.
      e.preventDefault();
      void printDrawing(c, 'sheet');
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || readOnly) return undefined;
    const map: Record<string, DrawingToolId> = {
      v: 'select',
      s: 'section',
      e: 'detail',
      d: 'dimension',
      i: 'import',
      w: 'views',
    };
    const t = map[e.key.toLowerCase()];
    if (t) {
      e.preventDefault();
      onTool(t);
      return true;
    }
    return undefined;
  };

  const cellEditor =
    ui.editingCell && b && composed && sheet
      ? (() => {
          const cell = composed.template.titleBlock.cells.find((x) => x.slot === ui.editingCell);
          const row = titleRows(b, sheet.id).rows.find((r) => r.slot === ui.editingCell);
          if (!cell || !row) return null;
          return { cell, row };
        })()
      : null;

  return (
    <DrawingShell
      tier={tier}
      title={b?.drawing.name ?? 'Drawing'}
      onBack={onClose}
      sheets={b ? b.drawing.sheets.map((s) => ({ id: s.id, name: s.name })) : []}
      sheetId={sheet?.id ?? null}
      onSheet={(sid) => c.patch({ sheetId: sid, selected: null })}
      {...(wb.store.canUndo() && !readOnly ? { onUndo: () => wb.undo() } : {})}
      {...(wb.store.canRedo() && !readOnly ? { onRedo: () => wb.redo() } : {})}
      actions={
        <div className="flex items-center gap-1.5 pl-1">
          {b?.drawing.configurationId !== undefined && b ? (
            <ConfigBadge
              name={
                b.drawing.configurationId
                  ? (b.part.configurations?.find((k) => k.id === b.drawing.configurationId)?.name ??
                    'Missing configuration')
                  : 'Default'
              }
              {...(b.drawing.configurationId &&
              !b.part.configurations?.some((k) => k.id === b.drawing.configurationId)
                ? { missing: true }
                : {})}
            />
          ) : null}
        </div>
      }
      {...(readOnly
        ? {}
        : {
            tools: (
              <DrawingToolbar
                active={activeTool}
                disabled={disabledTools}
                onTool={onTool}
                orientation={tier === 'desktop' ? 'vertical' : 'horizontal'}
                size={size}
              />
            ),
          })}
      canvas={
        <SheetViewer
          ref={viewer}
          model={model}
          sheet={
            composed ? { w: composed.list.width, h: composed.list.height } : { w: 420, h: 297 }
          }
          fitKey={sheet?.id ?? 'none'}
          label={
            b && sheet
              ? `${sheet.name} of ${b.drawing.name}: ${b.drawing.views.filter((v) => v.sheetId === sheet.id).length} views, ${b.drawing.placements.length} annotations, ${attentionN} needing attention`
              : 'Drawing sheet'
          }
          selected={selectedKeys}
          hover={ui.hover}
          pending={ui.pending}
          cursor={ui.tool === 'select' ? 'default' : 'crosshair'}
          begin={readOnly ? () => null : (p) => beginInteraction(c, p)}
          onHover={(p) => {
            if (hoverRef.current) cancelAnimationFrame(hoverRef.current);
            hoverRef.current = requestAnimationFrame(() => {
              if (!p || ui.tool === 'select' || readOnly) {
                if (ui.hover !== null) c.patch({ hover: null });
                return;
              }
              const hit = viewHit(c, p);
              const key =
                hit?.source.kind === 'view' && (hit.source.edge || hit.source.face)
                  ? sourceKey(hit.source)
                  : null;
              if (key !== ui.hover) c.patch({ hover: key });
            });
          }}
          onBackgroundTap={() => {
            if (ui.tool === 'select') c.select(null);
          }}
          onKeyDown={onKeyDown}
          overlay={(o) =>
            b ? <SheetOverlay ui={ui} b={b} mm={o.mm} sheet={o.sheet} touch={touch} /> : null
          }
          floating={(f) =>
            cellEditor ? (
              <InlineCellEditor
                caption={cellEditor.cell.caption}
                value={cellEditor.row.text}
                {...(cellEditor.row.bound !== undefined ? { bound: cellEditor.row.bound } : {})}
                {...(cellEditor.row.source === 'override' ? { overridden: true } : {})}
                box={(() => {
                  const a = f.toScreen([cellEditor.cell.box.min[0], cellEditor.cell.box.max[1]]);
                  const z = f.toScreen([cellEditor.cell.box.max[0], cellEditor.cell.box.min[1]]);
                  return { x: a.x, y: a.y, width: z.x - a.x, height: z.y - a.y };
                })()}
                onCommit={(text) => {
                  if (b && sheet) setTitleField(c, b.drawing, sheet.id, cellEditor.cell.slot, text);
                  c.patch({ editingCell: null });
                }}
                onCancel={() => c.patch({ editingCell: null })}
              />
            ) : null
          }
        />
      }
      overlay={
        <div className="pointer-events-none absolute inset-x-0 bottom-16 flex flex-col items-center gap-2 px-3">
          {hintText && !readOnly ? (
            <PromptChip
              size={size}
              count={ui.hint?.picks.length ?? 0}
              onCancel={() => c.setTool('select')}
            >
              {hintText}
            </PromptChip>
          ) : null}
          {pendingNote ? (
            <output
              data-testid="pending-chip"
              className="pointer-events-auto rounded-full bg-surface px-3 py-1 text-xs text-fg-muted shadow-pop"
            >
              {pendingNote}
            </output>
          ) : null}
          {b && b.problems.length > 0 ? (
            <div
              role="alert"
              data-testid="projection-problem"
              className="pointer-events-auto max-w-prose rounded-panel bg-warning-soft px-3 py-2 text-xs text-warning-text shadow-pop"
            >
              {projectionNotice(b.problems.length, b.problems[0]?.message ?? '')}
            </div>
          ) : null}
          {ui.refining && !pendingNote ? (
            <span
              data-testid="refining-chip"
              className="pointer-events-none rounded-full bg-surface px-3 py-1 text-xs text-fg-subtle shadow-pop"
            >
              Refining edges…
            </span>
          ) : null}
          {!b && !ui.error ? (
            <output
              data-testid="building-chip"
              className="pointer-events-auto rounded-full bg-surface px-3 py-1 text-xs text-fg-muted shadow-pop"
            >
              Building the drawing…
            </output>
          ) : null}
          {ui.error ? (
            <div
              role="alert"
              data-testid="drawing-error"
              className="pointer-events-auto rounded-panel bg-danger-soft px-3 py-2 text-xs text-danger-text shadow-pop"
            >
              {ui.error}
            </div>
          ) : null}
          {ui.toast ? (
            <output
              data-testid="drawing-toast"
              data-tone={ui.toast.tone}
              className="pointer-events-auto rounded-full bg-fg px-4 py-2 text-ui text-bg shadow-pop"
            >
              {ui.toast.text}
            </output>
          ) : null}
        </div>
      }
      panels={panels}
      panel={activePanel}
      onPanel={(p) => c.patch({ panel: p as DrawingPanel })}
    />
  );
}

/** What the sheet says when the drawing kernel could not project a view (its Wasm failed to load). */
function projectionNotice(count: number, message: string): string {
  return `${count === 1 ? 'One view' : `${count} views`} could not be drawn: ${message.replace(/\.$/, '')}. Dimensions and the rest of the sheet are unaffected. Reload the page to try the drawing kernel again.`;
}

export type { Vec2 };
