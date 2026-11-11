/**
 * The annotation and drawing half of `@wren-cad/document` is a separate chunk (ADR-090 amendment):
 * the store never imports it, so the initial route stays small. Anything that opens a document
 * (the library, a `.wrencad` file, a sync download) awaits `ensureDrawingSupport()` first, and the
 * document package refuses annotation and drawing commands and documents until it has registered.
 */

type DrawingModule = typeof import('@wren-cad/document/drawing');

let loading: Promise<void> | undefined;
let loaded: DrawingModule | undefined;

export function ensureDrawingSupport(): Promise<void> {
  loading ??= import('@wren-cad/document/drawing')
    .then((m) => {
      m.registerDrawingSupport();
      loaded = m;
    })
    .catch((e: unknown) => {
      loading = undefined; // a failed fetch (offline, deploy in flight) may be retried
      throw e;
    });
  return loading;
}

/**
 * The loaded module (rules, ISO 286, view frames) for code that runs after `ensureDrawingSupport()`:
 * the drawing route reads it here instead of importing it, so the bundler keeps one chunk for it.
 */
export function drawingDocument(): DrawingModule {
  if (!loaded) throw new Error('Drawing support has not loaded yet');
  return loaded;
}
