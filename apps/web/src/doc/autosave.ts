/**
 * Debounced autosave (PLAN §2.6 local-first): saves the latest document ~500 ms after edits
 * settle, never runs two saves at once, and can be flushed immediately (page hidden, switching
 * documents). Errors are reported but never lose the pending document: the next edit retries.
 */

import type { WhittleDoc } from '@whittle/contracts';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutosaverOptions {
  save(doc: WhittleDoc): Promise<void>;
  delayMs?: number;
  onError?(error: unknown): void;
  /** Called after each successful save. */
  onSaved?(doc: WhittleDoc): void;
  timers?: Timers;
}

export interface Autosaver {
  /** The document changed; save it once edits settle. */
  schedule(doc: WhittleDoc): void;
  /** Saves the pending document now (no-op when nothing is pending). */
  flush(): Promise<void>;
  /** Drops anything pending (e.g. the document was deleted). */
  cancel(): void;
  readonly pending: boolean;
  /** The last document that reached storage. */
  readonly lastSaved: WhittleDoc | null;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createAutosaver(options: AutosaverOptions): Autosaver {
  const delay = options.delayMs ?? 500;
  const timers = options.timers ?? defaultTimers;
  let pending: WhittleDoc | null = null;
  let timer: unknown = null;
  let running: Promise<void> = Promise.resolve();
  let lastSaved: WhittleDoc | null = null;

  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  function flush(): Promise<void> {
    clear();
    const doc = pending;
    if (!doc) return running;
    pending = null;
    running = running.then(async () => {
      if (doc === lastSaved) return;
      try {
        await options.save(doc);
        lastSaved = doc;
        options.onSaved?.(doc);
      } catch (err) {
        // Keep it for the next attempt unless something newer is already waiting.
        if (!pending) pending = doc;
        options.onError?.(err);
      }
    });
    return running;
  }

  return {
    schedule(doc) {
      pending = doc;
      clear();
      timer = timers.setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
    },
    flush,
    cancel() {
      clear();
      pending = null;
    },
    get pending() {
      return pending !== null;
    },
    get lastSaved() {
      return lastSaved;
    },
  };
}
