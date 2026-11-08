// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-only: File System Access API with <a download> / <input type=file> fallbacks.

export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
}

interface PickerWritable {
  write(d: BufferSource): Promise<void>;
  close(): Promise<void>;
}
interface PickerHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<PickerWritable>;
}
interface PickerWindow {
  showSaveFilePicker?: (o: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<PickerHandle>;
  showOpenFilePicker?: (o: {
    multiple?: boolean;
    types?: { description?: string; accept: Record<string, string[]> }[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<PickerHandle[]>;
  launchQueue?: {
    setConsumer(cb: (p: { files: PickerHandle[] }) => void | Promise<void>): void;
  };
}

const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

function extensionOf(name: string): string {
  const m = name.match(/\.[A-Za-z0-9]+$/);
  return m ? m[0].toLowerCase() : '';
}

/**
 * Save bytes to the user's disk. Uses `showSaveFilePicker` when available, else triggers a
 * download via `<a download>`. Resolves `'cancelled'` if the user dismissed the picker.
 */
export async function saveFile(
  bytes: Uint8Array,
  suggestedName: string,
  mime = 'application/octet-stream',
): Promise<'saved' | 'cancelled'> {
  const w = globalThis as unknown as PickerWindow;
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const ext = extensionOf(suggestedName);
      const handle = await w.showSaveFilePicker({
        suggestedName,
        ...(ext ? { types: [{ accept: { [mime]: [ext] } }] } : {}),
      });
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as BufferSource);
      await writable.close();
      return 'saved';
    } catch (e) {
      if (isAbort(e)) return 'cancelled';
      // SecurityError (no user gesture), NotAllowedError, ...: fall through to a download.
    }
  }
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser a moment to start the download before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return 'saved';
}

/**
 * Let the user pick one file. `accept` is a list of extensions (e.g. `['.whittle', '.step']`).
 * Resolves `null` when the user cancels.
 */
export async function openFile(accept: string[] = []): Promise<OpenedFile | null> {
  const w = globalThis as unknown as PickerWindow;
  if (typeof w.showOpenFilePicker === 'function') {
    try {
      const [handle] = await w.showOpenFilePicker({
        multiple: false,
        ...(accept.length
          ? {
              types: [{ accept: { 'application/octet-stream': accept } }],
              excludeAcceptAllOption: false,
            }
          : {}),
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } catch (e) {
      if (isAbort(e)) return null;
    }
  }
  return new Promise<OpenedFile | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept.length) input.accept = accept.join(',');
    input.style.display = 'none';
    const done = (v: OpenedFile | null) => {
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      try {
        done({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      } catch (e) {
        input.remove();
        reject(e);
      }
    });
    input.addEventListener('cancel', () => done(null));
    document.body.append(input);
    input.click();
  });
}

/**
 * File Handling (PLAN §2.6): files opened from the OS (`.whittle`, `.step`, ...) arrive through
 * `launchQueue`. Returns false where the API does not exist. Call once at startup.
 */
export function onLaunchFiles(cb: (files: OpenedFile[]) => void): boolean {
  const w = globalThis as unknown as PickerWindow;
  if (!w.launchQueue?.setConsumer) return false;
  w.launchQueue.setConsumer(async (params) => {
    const files: OpenedFile[] = [];
    for (const h of params.files) {
      try {
        const f = await h.getFile();
        files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      } catch {
        // Permission revoked or file vanished: skip it.
      }
    }
    if (files.length) cb(files);
  });
  return true;
}
