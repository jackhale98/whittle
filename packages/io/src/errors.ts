// SPDX-License-Identifier: GPL-3.0-or-later

export type IoErrorCode = 'too-large' | 'malformed' | 'unsupported' | 'empty';

/** Raised by importers on bad input. `message` is human-readable and safe to show in the UI. */
export class IoError extends Error {
  readonly code: IoErrorCode;
  constructor(code: IoErrorCode, message: string) {
    super(message);
    this.name = 'IoError';
    this.code = code;
  }
}

/** Guard rails so junk input can never hang or exhaust memory. */
export interface ImportLimits {
  /** Max input size in bytes (and max decompressed size of any zip entry). Default 256 MiB. */
  maxBytes: number;
  /** Max triangles produced. Default 5,000,000. */
  maxTriangles: number;
}

export const DEFAULT_LIMITS: ImportLimits = {
  maxBytes: 256 * 1024 * 1024,
  maxTriangles: 5_000_000,
};

export function resolveLimits(l?: Partial<ImportLimits>): ImportLimits {
  return { ...DEFAULT_LIMITS, ...l };
}

export function checkSize(bytes: Uint8Array, limits: ImportLimits, what: string): void {
  if (bytes.byteLength > limits.maxBytes) {
    throw new IoError(
      'too-large',
      `${what} is ${(bytes.byteLength / 1048576).toFixed(1)} MiB; the limit is ${(limits.maxBytes / 1048576).toFixed(0)} MiB.`,
    );
  }
}

export function checkTriangles(count: number, limits: ImportLimits, what: string): void {
  if (count > limits.maxTriangles) {
    throw new IoError(
      'too-large',
      `${what} has ${count.toLocaleString('en-US')} triangles; the limit is ${limits.maxTriangles.toLocaleString('en-US')}.`,
    );
  }
}
