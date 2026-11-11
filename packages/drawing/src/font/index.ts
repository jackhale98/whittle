/**
 * `@wren-cad/drawing/font`: the bundled drawing font (Osifont, LGPL-3.0 with the GPL font
 * exception; ADR-091). Self-hosted: the URL is a hashed asset of the app build (cross-origin
 * isolation, no CDN), loaded on demand by the drawing route and the PDF export only.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export { OSIFONT_METRICS } from './osifont-metrics';

/** The CSS family name the SVG editor model uses (`@font-face` is declared by the UI). */
export const DRAWING_FONT_FAMILY = 'osifont';

/** URL of the TTF (resolved by the bundler as an asset). */
export function drawingFontUrl(): string {
  return new URL('../../assets/fonts/osifont-lgpl3fe.ttf', import.meta.url).href;
}

let cached: Promise<Uint8Array> | undefined;

/** Fetches the TTF once (PDF export embeds a subset of it). */
export function loadDrawingFont(fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  cached ??= fetcher(drawingFontUrl()).then(async (r) => {
    if (!r.ok) throw new Error(`drawing font: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  });
  return cached;
}
