/**
 * The annotation and drawing half of `@wren-cad/document` is a separate chunk (ADR-090 amendment):
 * the store never imports it, so the initial route stays small. Anything that opens a document
 * (the library, a `.wrencad` file, a sync download) awaits `ensureDrawingSupport()` first, and the
 * document package refuses annotation and drawing commands and documents until it has registered.
 */

let loading: Promise<void> | undefined;

export function ensureDrawingSupport(): Promise<void> {
  loading ??= import('@wren-cad/document/drawing')
    .then((m) => m.registerDrawingSupport())
    .catch((e: unknown) => {
      loading = undefined; // a failed fetch (offline, deploy in flight) may be retried
      throw e;
    });
  return loading;
}
