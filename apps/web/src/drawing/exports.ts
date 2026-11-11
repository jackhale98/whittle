/**
 * Drawing export: PDF (vector, true scale), SVG and DXF (R12 and R2000), from the display lists
 * the sheet is drawn from. The renderers and the Osifont file load on the first export only.
 */

import type { DrawingExportFormat } from '@wren-cad/ui/drawing';
import type { DrawingController } from './controller';

export interface ExportedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'drawing';

/** Builds the files of an export (no download): the unit under test. */
export async function buildExport(
  c: DrawingController,
  format: DrawingExportFormat,
  scope: 'sheet' | 'all',
): Promise<ExportedFile[]> {
  const b = c.built();
  if (!b) throw new Error('The drawing has not been built yet.');
  if (c.ui.get().pending) throw new Error('The model is updating: try again in a moment.');
  const current = c.sheet()?.id;
  const sheets = b.build.sheets.filter((s) => scope === 'all' || s.sheetId === current);
  if (sheets.length === 0) throw new Error('There is no sheet to export.');
  const base = slug(b.drawing.name);
  const nameOf = (id: string) => slug(b.drawing.sheets.find((s) => s.id === id)?.name ?? 'sheet');
  const suffix = (id: string) => (sheets.length > 1 ? `-${nameOf(id)}` : '');
  const enc = new TextEncoder();

  switch (format) {
    case 'pdf': {
      const [{ renderPdf }, { loadDrawingFont }] = await Promise.all([
        import('@wren-cad/drawing/pdf'),
        import('@wren-cad/drawing/font'),
      ]);
      const font = await loadDrawingFont();
      const bytes = renderPdf(
        sheets.map((s) => ({ list: s.list, style: b.drawing.style })),
        { font },
      );
      return [{ name: `${base}.pdf`, mime: 'application/pdf', bytes }];
    }
    case 'svg': {
      const { renderSvg } = await import('@wren-cad/drawing/svg');
      return sheets.map((s) => ({
        name: `${base}${suffix(s.sheetId)}.svg`,
        mime: 'image/svg+xml',
        bytes: enc.encode(renderSvg(s.list, b.drawing.style, { paper: '#ffffff' })),
      }));
    }
    case 'dxf-r12':
    case 'dxf-r2000': {
      const { renderDxf } = await import('@wren-cad/drawing/dxf');
      const profile = format === 'dxf-r12' ? 'r12' : 'r2000';
      return sheets.map((s) => ({
        name: `${base}${suffix(s.sheetId)}-${profile}.dxf`,
        mime: 'application/dxf',
        bytes: enc.encode(renderDxf(s.list, b.drawing.style, { profile })),
      }));
    }
  }
}

/** A plain download (several files in a row cannot each open a save dialog). */
export function downloadFile(f: ExportedFile): void {
  const url = URL.createObjectURL(new Blob([f.bytes as unknown as BlobPart], { type: f.mime }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** Export and download; reports through the route's toast. */
export async function exportDrawing(
  c: DrawingController,
  format: DrawingExportFormat,
  scope: 'sheet' | 'all',
): Promise<void> {
  c.patch({ exporting: format });
  try {
    const files = await buildExport(c, format, scope);
    for (const f of files) downloadFile(f);
    c.toast(files.length === 1 ? `Saved ${files[0]?.name}` : `Saved ${files.length} files`);
  } catch (e) {
    c.toast(e instanceof Error ? e.message : 'The export failed.', 'error');
  } finally {
    c.patch({ exporting: null });
  }
}
