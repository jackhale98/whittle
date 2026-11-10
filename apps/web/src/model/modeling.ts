/**
 * The app's single doorway to parametric regeneration (`ModelingApi`, packages/contracts
 * modeling.ts). Everything that talks to the regen engine goes through `createModeling()`:
 * the regen loop (coarse now, fine on idle, stale results dropped), selection → `refFor`, and
 * `exportPart`. The engine is any `Remote<ModelingApi>`-shaped object: the real kernel worker
 * once the regen engine lands, or the fake (`fake-modeling.ts`) until then. See `engine.ts`.
 */

import type {
  EntityQuery,
  EntityRef,
  ExportFormat,
  ExportOptions,
  Id,
  KernelError,
  Measurement,
  MeasureTarget,
  MeshQuality,
  ModelingApi,
  RegenResult,
  Result,
  WrenDoc,
} from '@wren-cad/contracts';

/** The calls the app needs. `Remote<ModelingApi>` (Comlink) and the fake both satisfy it. */
export type ModelingPort = Pick<
  ModelingApi,
  'regenerate' | 'refFor' | 'exportPart' | 'importFile' | 'closePart'
> &
  Partial<Pick<ModelingApi, 'configureRegen' | 'measure' | 'compare' | 'memoryStats'>>;

export interface RegenOutcome {
  result: RegenResult;
  quality: MeshQuality;
  /** The document the result was computed for (identity; the store keeps docs immutable). */
  doc: WrenDoc;
}

/** Schedules `run` when the main thread is idle; returns a cancel function. */
export type IdleScheduler = (run: () => void) => () => void;

export const defaultIdle: IdleScheduler = (run) => {
  const g = globalThis as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };
  if (g.requestIdleCallback && g.cancelIdleCallback) {
    const cancelIdle = g.cancelIdleCallback;
    // A short delay first so a burst of edits (typing, drags) never pays for a fine mesh.
    let h = 0;
    const t = setTimeout(() => {
      h = g.requestIdleCallback?.(run, { timeout: 1000 }) ?? 0;
    }, 150);
    return () => {
      clearTimeout(t);
      if (h) cancelIdle(h);
    };
  }
  const t = setTimeout(run, 250);
  return () => clearTimeout(t);
};

export interface RegenLoopOptions {
  port: ModelingPort;
  getDoc(): WrenDoc;
  /** Part to regenerate (M1: the document's first part). */
  partOf?(doc: WrenDoc): Id | null;
  onResult(outcome: RegenOutcome): void;
  /** The engine threw (worker crashed, bad input). Regeneration continues on the next edit. */
  onError?(error: KernelError): void;
  idle?: IdleScheduler;
  /** Skip the fine pass (tests, low-power). */
  fine?: boolean;
  /**
   * Attachment files the document's import features reference (`ImportFeature.source`). Each is
   * sent to the engine once per part and loop (= worker) lifetime, keyed by sha256, then omitted:
   * the engine caches imported shapes per part by sha256 (contracts `RegenRequest.attachments`).
   * `forget(partId)` (the part was closed in the engine) sends them again next time.
   */
  attachments?(doc: WrenDoc): readonly Attachment[];
}

export interface Attachment {
  path: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface RegenLoop {
  /** The document changed: regenerate it (coarse now, fine when idle). */
  request(): void;
  /** Resolves when nothing is running or queued and the latest result has been delivered. */
  whenIdle(): Promise<void>;
  /**
   * Runs `fn` with the engine to itself: waits for the loop to go idle, holds back every regen
   * meanwhile, then regenerates the current document again (the live model may have been
   * re-regenerated in `fn`, e.g. to export another configuration).
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Number of regenerate calls made (diagnostics/tests). */
  readonly calls: number;
  /** `<partId>:<sha256>` of every attachment already sent to this engine. */
  readonly sentAttachments: ReadonlySet<string>;
  /** The part was closed in the engine (`closePart`): its revisions start again. */
  forget(partId: Id): void;
  dispose(): void;
}

const firstPart = (doc: WrenDoc): Id | null => doc.parts[0]?.id ?? null;

function asKernelError(err: unknown): KernelError {
  return {
    code: 'INTERNAL',
    message: 'The geometry engine stopped responding. Your document is safe.',
    detail: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Regeneration loop. At most one `regenerate` call is in flight (the worker is serial anyway);
 * edits made meanwhile coalesce into one follow-up call with the latest document. Results are
 * delivered in order and dropped when stale: by `revision` (contract), by request order, and
 * fine results whose document is no longer current.
 */
export function createRegenLoop(options: RegenLoopOptions): RegenLoop {
  const { port, getDoc, onResult, onError } = options;
  const partOf = options.partOf ?? firstPart;
  const idle = options.idle ?? defaultIdle;
  const wantFine = options.fine ?? true;

  let busy = false;
  let dirty = false;
  let disposed = false;
  let calls = 0;
  let seq = 0;
  let lastDelivered = 0;
  const lastRevision = new Map<Id, number>();
  const sent = new Set<string>();
  let cancelFine: (() => void) | null = null;
  let finePendingFor: WrenDoc | null = null;
  let waiters: Array<() => void> = [];

  const settle = () => {
    if (busy || dirty || finePendingFor) return;
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };

  async function run(quality: MeshQuality, doc: WrenDoc): Promise<void> {
    const partId = partOf(doc);
    if (!partId) return;
    busy = true;
    calls++;
    const mySeq = ++seq;
    try {
      const fresh = (options.attachments?.(doc) ?? []).filter(
        (a) => !sent.has(`${partId}:${a.sha256}`),
      );
      const attachments: Record<string, Uint8Array> = {};
      for (const a of fresh) attachments[a.path] = a.bytes;
      const result = await port.regenerate({
        doc,
        partId,
        quality,
        massProperties: true,
        ...(fresh.length ? { attachments } : {}),
      });
      for (const a of fresh) sent.add(`${partId}:${a.sha256}`);
      if (disposed) return;
      const stale =
        mySeq < lastDelivered ||
        result.revision <= (lastRevision.get(result.partId) ?? Number.NEGATIVE_INFINITY) ||
        (quality === 'fine' && doc !== getDoc());
      if (!stale) {
        lastDelivered = mySeq;
        lastRevision.set(result.partId, result.revision);
        onResult({ result, quality, doc });
      }
    } catch (err) {
      if (!disposed) onError?.(asKernelError(err));
    } finally {
      busy = false;
    }
  }

  function scheduleFine(doc: WrenDoc) {
    cancelFine?.();
    if (!wantFine) return;
    finePendingFor = doc;
    cancelFine = idle(() => {
      cancelFine = null;
      const target = finePendingFor;
      finePendingFor = null;
      if (disposed || !target || target !== getDoc() || dirty) {
        settle();
        return;
      }
      void run('fine', target).then(pump);
    });
  }

  function pump(): void {
    if (disposed || busy) return;
    if (dirty) {
      dirty = false;
      cancelFine?.();
      cancelFine = null;
      finePendingFor = null;
      const doc = getDoc();
      void run('coarse', doc).then(() => {
        if (!dirty) scheduleFine(doc);
        pump();
      });
      return;
    }
    settle();
  }

  return {
    request() {
      if (disposed) return;
      dirty = true;
      pump();
    },
    whenIdle() {
      if (!busy && !dirty && !finePendingFor) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    async exclusive(fn) {
      while (busy || dirty || finePendingFor) {
        await new Promise<void>((resolve) => waiters.push(resolve));
        if (disposed) break;
      }
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
        dirty = true;
        pump();
      }
    },
    get calls() {
      return calls;
    },
    get sentAttachments() {
      return sent;
    },
    forget(partId) {
      lastRevision.delete(partId);
      for (const k of [...sent]) if (k.startsWith(`${partId}:`)) sent.delete(k);
    },
    dispose() {
      disposed = true;
      cancelFine?.();
      const w = waiters;
      waiters = [];
      for (const fn of w) fn();
    },
  };
}

/** Selection → persistent reference, exports and imports, all against the latest regen. */
export interface Modeling {
  readonly port: ModelingPort;
  refFor(partId: Id, query: EntityQuery): Promise<EntityRef | null>;
  exportPart(
    partId: Id,
    format: ExportFormat,
    options?: ExportOptions,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: KernelError }>;
  closePart(partId: Id): Promise<void>;
  /** Exact measurement on the latest regen (M2). */
  measure(partId: Id, a: MeasureTarget, b?: MeasureTarget): Promise<Result<Measurement>>;
}

export function createModeling(port: ModelingPort): Modeling {
  return {
    port,
    async measure(partId, a, b) {
      if (!port.measure)
        return {
          ok: false,
          error: { code: 'INTERNAL', message: 'This geometry engine cannot measure.' },
        };
      try {
        return await port.measure(partId, a, b);
      } catch (err) {
        return { ok: false, error: asKernelError(err) };
      }
    },
    async refFor(partId, query) {
      try {
        return await port.refFor(partId, query);
      } catch {
        return null;
      }
    },
    async exportPart(partId, format, options) {
      try {
        return await port.exportPart(partId, format, options);
      } catch (err) {
        return { ok: false, error: asKernelError(err) };
      }
    },
    async closePart(partId) {
      try {
        await port.closePart(partId);
      } catch {
        // Closing is best-effort.
      }
    },
  };
}
