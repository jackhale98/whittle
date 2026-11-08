// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-only.

export type ThumbnailSource = HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

export interface ThumbnailOptions {
  width?: number;
  height?: number;
  /** CSS colour painted behind the image; omit for transparency. */
  background?: string;
}

/** Scale `source` to cover a `width`×`height` PNG (centre-cropped) and return the PNG bytes. */
export async function canvasToThumbnail(
  source: ThumbnailSource,
  options: ThumbnailOptions = {},
): Promise<Uint8Array> {
  const width = options.width ?? 256;
  const height = options.height ?? 192;
  const sw = 'width' in source ? source.width : 0;
  const sh = 'height' in source ? source.height : 0;
  if (!sw || !sh) throw new Error('Thumbnail source has no pixels.');
  const scale = Math.max(width / sw, height / sh);
  const cw = width / scale;
  const ch = height / scale;
  const sx = (sw - cw) / 2;
  const sy = (sh - ch) / 2;

  const useOffscreen = typeof OffscreenCanvas !== 'undefined';
  const canvas: HTMLCanvasElement | OffscreenCanvas = useOffscreen
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('2D canvas is unavailable.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(source, sx, sy, cw, ch, 0, 0, width, height);
  const blob =
    canvas instanceof HTMLCanvasElement
      ? await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
      : await canvas.convertToBlob({ type: 'image/png' });
  if (!blob) throw new Error('PNG encoding failed.');
  return new Uint8Array(await blob.arrayBuffer());
}
