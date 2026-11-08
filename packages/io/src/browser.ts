// SPDX-License-Identifier: GPL-3.0-or-later
/** Browser-only entry point (DOM, IndexedDB, OPFS, File System Access). Not worker-safe. */
export { type OpenedFile, onLaunchFiles, openFile, saveFile } from './files';
export {
  type BlobStore,
  createOpfsStore,
  IdbLibrary,
  isQuotaError,
  type LibraryCodec,
  LibraryError,
  type LibraryErrorCode,
  type LibraryOptions,
  openLibrary,
} from './library';
export { canvasToThumbnail, type ThumbnailOptions, type ThumbnailSource } from './thumbnail';
