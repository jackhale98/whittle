/**
 * Print the drawing at true scale (ADR-092 amendment). The sheet is the same display list the PDF
 * and SVG are written from, drawn as an inline SVG whose size is the sheet's size in millimetres;
 * a print stylesheet sets the page to that size with no margin and hides the rest of the app. The
 * browser's own print dialog does the rest: print at 100% (actual size) and a 100 mm graduation
 * measures 100 mm. No dialog of ours, no PDF viewer plugin (it is not there on every browser).
 */

import type { DrawingController } from './controller';
import { exactSheets } from './exports';

export const PRINT_ROOT_ID = 'wren-print';

const num = (v: number): string => String(Math.round(v * 1000) / 1000);

/** The print stylesheet for pages of the given sizes (mm). Exported for tests. */
export function printCss(pages: readonly { w: number; h: number }[]): string {
  const named = pages
    .map((p, i) => `@page s${i} { size: ${num(p.w)}mm ${num(p.h)}mm; margin: 0; }`)
    .join('\n');
  const first = pages[0];
  return [
    first ? `@page { size: ${num(first.w)}mm ${num(first.h)}mm; margin: 0; }` : '',
    named,
    `@media screen { #${PRINT_ROOT_ID} { display: none !important; } }`,
    '@media print {',
    '  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }',
    `  body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }`,
    `  #${PRINT_ROOT_ID} { display: block !important; }`,
    `  #${PRINT_ROOT_ID} .wren-print-sheet { break-after: page; overflow: hidden; }`,
    `  #${PRINT_ROOT_ID} .wren-print-sheet:last-child { break-after: auto; }`,
    `  #${PRINT_ROOT_ID} svg { display: block; }`,
    ...pages.map((_, i) => `  #${PRINT_ROOT_ID} .wren-print-sheet.s${i} { page: s${i}; }`),
    '}',
  ].join('\n');
}

/** Removes the print root (after printing, or before the next print). */
export function clearPrint(): void {
  document.getElementById(PRINT_ROOT_ID)?.remove();
}

/**
 * Prints the current sheet or all of them. Resolves once the browser's print dialog has been
 * opened (`window.print` returns when it closes in most browsers; the root is cleared then or on
 * `afterprint`, and always before the next print).
 */
export async function printDrawing(c: DrawingController, scope: 'sheet' | 'all'): Promise<void> {
  c.patch({ exporting: 'print' });
  try {
    const { b, sheets } = await exactSheets(c, scope);
    const [{ renderSvg }, { loadDrawingFont }] = await Promise.all([
      import('@wren-cad/drawing/svg'),
      import('@wren-cad/drawing/font'),
    ]);
    await loadDrawingFont();
    clearPrint();
    const root = document.createElement('div');
    root.id = PRINT_ROOT_ID;
    root.setAttribute('aria-hidden', 'true');
    const style = document.createElement('style');
    style.textContent = printCss(sheets.map((s) => ({ w: s.list.width, h: s.list.height })));
    root.append(style);
    sheets.forEach((s, i) => {
      const page = document.createElement('div');
      page.className = `wren-print-sheet s${i}`;
      page.dataset.sheet = s.sheetId;
      // The XML prolog is for files; inline SVG starts at the element.
      page.innerHTML = renderSvg(s.list, b.drawing.style, { paper: '#ffffff' }).replace(
        /^<\?xml[^>]*\?>\s*/,
        '',
      );
      root.append(page);
    });
    document.body.append(root);
    try {
      await document.fonts?.ready;
    } catch {
      // Fonts that fail to load fall back to the sheet's sans-serif: the print still goes ahead.
    }
    window.addEventListener('afterprint', clearPrint, { once: true });
    window.print();
    c.toast(
      sheets.length === 1 ? 'Printing the sheet at true scale' : `Printing ${sheets.length} sheets`,
    );
  } catch (e) {
    clearPrint();
    c.toast(e instanceof Error ? e.message : 'The print failed.', 'error');
  } finally {
    c.patch({ exporting: null });
  }
}
