import { FileCode, FileDown, FileText, Image, Printer } from 'lucide-react';
import { useState } from 'react';
import { Segmented } from '../components/controls';
import { Button } from '../components/primitives';

export type DrawingExportFormat = 'pdf' | 'svg' | 'dxf-r12' | 'dxf-r2000';

const FORMATS: readonly {
  id: DrawingExportFormat;
  label: string;
  detail: string;
  icon: typeof FileText;
}[] = [
  {
    id: 'pdf',
    label: 'PDF',
    detail:
      'Vector, true scale: print at 100% (actual size) and a 100 mm graduation measures 100 mm.',
    icon: FileText,
  },
  { id: 'svg', label: 'SVG', detail: 'Vector, in millimetres.', icon: Image },
  {
    id: 'dxf-r12',
    label: 'DXF R12',
    detail: 'The safe choice for CNC and older CAD: plain lines, arcs and text.',
    icon: FileCode,
  },
  {
    id: 'dxf-r2000',
    label: 'DXF R2000',
    detail: 'Layers with line weights and ISO line types, for current CAD.',
    icon: FileCode,
  },
];

export interface DrawingExportPanelProps {
  sheetName: string;
  sheetCount: number;
  /** The format being written (a button shows it is working). */
  busy: DrawingExportFormat | 'print' | null;
  /** Why exporting is not possible right now (the drawing has not built, the model is updating). */
  unavailable?: string;
  /** Needs-attention items: a drawing with open items still exports, and says so. */
  attentionCount: number;
  onExport(format: DrawingExportFormat, scope: 'sheet' | 'all'): void;
  /** Print at true scale through the browser's own print dialog. */
  onPrint?(scope: 'sheet' | 'all'): void;
  size?: 'md' | 'touch';
}

/**
 * Export of the drawing (ADR-094): the PDF has every sheet, one page each; SVG, DXF and print
 * take the current sheet, or every sheet (SVG and DXF as one .zip).
 */
export function DrawingExportPanel({
  sheetName,
  sheetCount,
  busy,
  unavailable,
  attentionCount,
  onExport,
  onPrint,
  size = 'md',
}: DrawingExportPanelProps) {
  const [scope, setScope] = useState<'sheet' | 'all'>('sheet');
  const touch = size === 'touch';
  return (
    <div className="flex flex-col gap-3 px-4 pb-4" data-testid="drawing-export">
      {sheetCount > 1 ? (
        <div className="flex flex-col gap-1">
          <Segmented
            label="Sheets for SVG, DXF and print"
            size={touch ? 'touch' : 'md'}
            value={scope}
            onChange={setScope}
            options={[
              { value: 'sheet', label: sheetName },
              { value: 'all', label: `All ${sheetCount} sheets` },
            ]}
          />
          <span className="text-2xs text-fg-subtle" data-testid="export-scope-note">
            {scope === 'all'
              ? 'SVG and DXF download as one .zip with a file per sheet.'
              : `SVG and DXF of ${sheetName}.`}{' '}
            The PDF always has every sheet.
          </span>
        </div>
      ) : null}
      {attentionCount > 0 ? (
        <p className="rounded-control bg-warning-soft p-2.5 text-xs text-warning-text" role="note">
          {attentionCount} item{attentionCount === 1 ? '' : 's'} still need attention. They export
          in the attention style, without a value.
        </p>
      ) : null}
      {unavailable ? <p className="text-xs text-fg-muted">{unavailable}</p> : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {onPrint ? (
          <li className="flex items-start gap-3 rounded-control bg-surface-2 p-2.5">
            <Printer className="mt-1 size-5 shrink-0 text-fg-muted" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-ui font-semibold">Print</span>
              <span className="text-2xs text-fg-muted">
                True scale on a page of the sheet size: choose Actual size or 100% in the print
                dialog, and a 100 mm graduation measures 100 mm.
              </span>
              <Button
                variant="secondary"
                size={touch ? 'touch' : 'md'}
                icon={<Printer className="size-4" />}
                disabled={unavailable !== undefined || busy !== null}
                aria-busy={busy === 'print' || undefined}
                data-export="print"
                onClick={() => onPrint(scope)}
                className="self-start"
              >
                {busy === 'print' ? 'Preparing…' : 'Print…'}
              </Button>
            </div>
          </li>
        ) : null}
        {FORMATS.map((f) => {
          const Icon = f.icon;
          return (
            <li key={f.id} className="flex items-start gap-3 rounded-control bg-surface-2 p-2.5">
              <Icon className="mt-1 size-5 shrink-0 text-fg-muted" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-ui font-semibold">{f.label}</span>
                <span className="text-2xs text-fg-muted">
                  {f.id === 'pdf' && sheetCount > 1
                    ? `${f.detail} All ${sheetCount} sheets, one page each.`
                    : f.detail}
                </span>
                <Button
                  variant="secondary"
                  size={touch ? 'touch' : 'md'}
                  icon={<FileDown className="size-4" />}
                  disabled={unavailable !== undefined || busy !== null}
                  aria-busy={busy === f.id || undefined}
                  data-export={f.id}
                  onClick={() => onExport(f.id, f.id === 'pdf' ? 'all' : scope)}
                  className="self-start"
                >
                  {busy === f.id ? 'Writing…' : `Download ${f.label}`}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
