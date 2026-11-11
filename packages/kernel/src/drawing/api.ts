/**
 * The drawing worker's `DrawingKernelApi` (contracts drawing.ts) over the trimmed HLR Wasm build
 * (ADR-090 §14 and its amendment). Runs in the drawing worker only: never on the main thread and
 * never in the modeling worker (trap T12).
 *
 *  - The kernel loads lazily on the first `loadShape` (or an explicit `init`): threaded iff
 *    SharedArrayBuffer and cross-origin isolation are available, with its own small thread pool.
 *  - `loadShape` writes the BREP bytes to MEMFS, loads them once per key and keeps the shape in an
 *    LRU (count and bytes); evicted shapes release their handles. The names must match the BREP's
 *    edge and face counts, or the load fails (names are never guessed).
 *  - `project` maps the request (request.ts), runs one façade call and decodes it (decode.ts).
 *  - A trap inside Wasm (out of memory, abort) drops the instance and every loaded shape: the next
 *    `loadShape` starts a fresh kernel, and `project` asks for the shape again.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  DrawingKernelApi,
  KernelError,
  KernelVariant,
  Result,
  ShapeForDrawing,
  ViewProjection,
  ViewProjectionRequest,
} from '@wren-cad/contracts';
import type { KernelModuleOptions } from '../facade';
import { decodeProjection } from './decode';
import {
  type DrawingInitModule,
  type DrawingKernelModule,
  instantiateDrawingKernel,
  type RawDrawingInfo,
  type RawLoadedShape,
  type RawProjection,
} from './facade';
import { Lru } from './lru';
import { projectionKey, toFacadeRequest, viewBounds } from './request';

/** How to obtain one drawing kernel variant. */
export interface DrawingVariantSource {
  /** Loads the generated `drawing/dist/init.<variant>.js` (a static `import()` for bundlers). */
  load(): Promise<DrawingInitModule>;
  /** The variant's `.wasm` URL (bundler asset); absent in Node, where the glue finds it itself. */
  wasmUrl?: string;
}

export interface DrawingKernelDeps {
  variants: Record<KernelVariant, DrawingVariantSource>;
  /** Default: `crossOriginIsolated && SharedArrayBuffer`. */
  canUseThreads?: () => boolean;
  /** OCCT threads of the threaded build. Default min(4, cores): the modeling worker has its own. */
  threads?: number;
  /** Loaded shapes kept (default 8) and their BREP bytes (default 256 MiB). */
  maxShapes?: number;
  maxBytes?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

export interface DrawingKernelInfo {
  variant: KernelVariant;
  occtVersion: string;
  buildId: string;
  initMs: number;
}

/** The drawing worker's Comlink surface: the contract plus warm-up and diagnostics. */
export interface DrawingWorkerApi extends DrawingKernelApi {
  /** Loads the kernel now (otherwise the first `loadShape` does). Idempotent. */
  init(options?: { variant?: KernelVariant }): Promise<Result<DrawingKernelInfo>>;
  /** Drops a loaded shape (a part closed). Unknown keys are ignored. */
  releaseShape(key: string): Promise<void>;
  stats(): Promise<{ shapes: number; bytes: number; liveHandles: number; variant?: KernelVariant }>;
}

interface Loaded {
  handle: number;
  edgeNames: string[];
  faceNames: string[];
  bounds: ShapeForDrawing['bounds'];
}

const error = (code: KernelError['code'], message: string, hint?: string, detail?: string) => {
  const e: KernelError = { code, message };
  if (hint !== undefined) e.hint = hint;
  if (detail !== undefined) e.detail = detail;
  return e;
};
const fail = (e: KernelError): { ok: false; error: KernelError } => ({ ok: false, error: e });

const describe = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

export const defaultCanUseThreads = (): boolean =>
  typeof SharedArrayBuffer !== 'undefined' &&
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

function parseResult<T>(json: string, operation: string): Result<T> {
  try {
    const parsed = JSON.parse(json) as Result<T>;
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.ok === 'boolean') {
      return parsed;
    }
  } catch {
    // fall through
  }
  return fail(
    error(
      'INTERNAL',
      `${operation}: the drawing kernel returned a malformed result`,
      undefined,
      json.slice(0, 200),
    ),
  );
}

function validShape(shape: ShapeForDrawing): string | null {
  if (shape === null || typeof shape !== 'object') return 'the shape is missing';
  if (typeof shape.key !== 'string' || shape.key === '') return 'the shape has no key';
  if (!(shape.brep instanceof Uint8Array) || shape.brep.byteLength === 0)
    return 'the BREP is empty';
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (!strings(shape.edgeNames) || !strings(shape.faceNames)) return 'the names are not strings';
  const b = shape.bounds;
  const vec = (v: unknown) =>
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (b === null || typeof b !== 'object' || !vec(b.min) || !vec(b.max))
    return 'the bounds are not finite';
  return null;
}

export function createDrawingKernelApi(deps: DrawingKernelDeps): DrawingWorkerApi {
  const now = deps.now ?? (() => performance.now());
  const shapes = new Lru<Loaded>({
    maxEntries: deps.maxShapes ?? 8,
    maxBytes: deps.maxBytes ?? 256 * 1024 * 1024,
  });
  let kernel: DrawingKernelModule | null = null;
  let info: DrawingKernelInfo | null = null;
  let pending: Promise<Result<DrawingKernelInfo>> | null = null;
  let memfs = 0;

  const releaseAll = (values: Loaded[]) => {
    const k = kernel;
    if (k === null) return;
    for (const v of values) {
      try {
        k.release(v.handle);
      } catch {
        // a poisoned instance is dropped anyway
      }
    }
  };

  /** A trap inside Wasm: the instance and its shapes are gone. */
  const poison = (operation: string, e: unknown) => {
    shapes.clear();
    kernel = null;
    info = null;
    return fail(
      error(
        'INTERNAL',
        `${operation} crashed the drawing kernel`,
        'The drawing worker restarts its kernel; load the shape again.',
        describe(e),
      ),
    );
  };

  async function load(variantOption?: KernelVariant): Promise<Result<DrawingKernelInfo>> {
    const started = now();
    const canThread = (deps.canUseThreads ?? defaultCanUseThreads)();
    const variant: KernelVariant = variantOption ?? (canThread ? 'threaded' : 'single');
    if (variant === 'threaded' && typeof SharedArrayBuffer === 'undefined') {
      return fail(
        error(
          'INVALID_INPUT',
          'The threaded drawing kernel needs SharedArrayBuffer (cross-origin isolation)',
          'Use the single-threaded drawing kernel.',
        ),
      );
    }
    const source = deps.variants[variant];
    const options: KernelModuleOptions & { threadCount?: number } = {};
    const cores =
      typeof navigator !== 'undefined' && Number.isInteger(navigator.hardwareConcurrency)
        ? navigator.hardwareConcurrency
        : 4;
    const threads = Math.max(1, Math.min(deps.threads ?? 4, cores));
    if (variant === 'threaded') options.threadCount = threads;
    let rejectLoad: (e: unknown) => void = () => {};
    const loadFailed = new Promise<never>((_, reject) => {
      rejectLoad = reject;
    });
    if (source.wasmUrl !== undefined) {
      const url = source.wasmUrl;
      options.locateFile = (path, prefix) => (path.endsWith('.wasm') ? url : `${prefix}${path}`);
      const fetchImpl = deps.fetch ?? globalThis.fetch;
      if (
        typeof fetchImpl === 'function' &&
        typeof WebAssembly.instantiateStreaming === 'function'
      ) {
        options.instantiateWasm = (imports, receiveInstance) => {
          fetchImpl(url, { credentials: 'same-origin' })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
              return WebAssembly.instantiateStreaming(response, imports);
            })
            .then(({ instance, module }) => receiveInstance(instance, module))
            .catch((e: unknown) => rejectLoad(e));
          return {};
        };
      }
    }
    try {
      const init = await source.load();
      const instance = await Promise.race([instantiateDrawingKernel(init, options), loadFailed]);
      const raw = parseResult<RawDrawingInfo>(instance.drawingInfo(), 'drawingInfo');
      if (!raw.ok) return raw;
      if (raw.value.kind !== 'drawing' || raw.value.threads !== (variant === 'threaded')) {
        return fail(error('INTERNAL', `Loaded module is not the ${variant} drawing kernel`));
      }
      if (variant === 'threaded') {
        const configured = parseResult<unknown>(
          instance.configureThreads(threads),
          'configureThreads',
        );
        if (!configured.ok) return configured;
      }
      kernel = instance;
      info = {
        variant,
        occtVersion: raw.value.occtVersion,
        buildId: raw.value.buildId,
        initMs: now() - started,
      };
      return { ok: true, value: info };
    } catch (e) {
      return fail(
        error('INTERNAL', `Failed to load the ${variant} drawing kernel`, undefined, describe(e)),
      );
    }
  }

  const api: DrawingWorkerApi = {
    init(options = {}) {
      if (kernel !== null && info !== null) {
        if (options.variant === undefined || options.variant === info.variant) {
          return Promise.resolve({ ok: true, value: info });
        }
        return Promise.resolve(
          fail(
            error(
              'INVALID_INPUT',
              `The ${info.variant} drawing kernel is already loaded`,
              'Start a new drawing worker to switch variants.',
            ),
          ),
        );
      }
      if (pending === null) {
        pending = load(options.variant).finally(() => {
          pending = null;
        });
      }
      return pending;
    },

    async loadShape(shape) {
      const invalid = validShape(shape);
      if (invalid !== null)
        return fail(error('INVALID_INPUT', `Cannot load the part for drawing: ${invalid}`));
      if (kernel !== null && shapes.get(shape.key) !== undefined) return { ok: true };
      const ready = await api.init();
      if (!ready.ok) return ready;
      const k = kernel as DrawingKernelModule | null;
      if (k === null) return fail(error('NOT_INITIALISED', 'The drawing kernel is not loaded'));
      if (shapes.get(shape.key) !== undefined) return { ok: true }; // loaded while we waited
      const path = `/wren-drawing-${++memfs}.brep`;
      let raw: string;
      try {
        k.FS.writeFile(path, shape.brep);
        try {
          raw = k.loadShape(path);
        } finally {
          try {
            k.FS.unlink(path);
          } catch {
            // already gone
          }
        }
      } catch (e) {
        return poison('loadShape', e);
      }
      const r = parseResult<RawLoadedShape>(raw, 'loadShape');
      if (!r.ok) return r;
      const { handle, edges, faces } = r.value;
      const mismatch =
        (shape.edgeNames.length > 0 && shape.edgeNames.length !== edges) ||
        (shape.faceNames.length > 0 && shape.faceNames.length !== faces);
      if (mismatch) {
        k.release(handle);
        return fail(
          error(
            'INVALID_INPUT',
            "The part's names do not match its shape",
            'Rebuild the part and open the drawing again.',
            `BREP: ${edges} edges, ${faces} faces; names: ${shape.edgeNames.length} edges, ${shape.faceNames.length} faces`,
          ),
        );
      }
      const evicted = shapes.set(
        shape.key,
        { handle, edgeNames: shape.edgeNames, faceNames: shape.faceNames, bounds: shape.bounds },
        shape.brep.byteLength,
      );
      releaseAll(evicted);
      return { ok: true };
    },

    async hasShape(key) {
      return kernel !== null && shapes.has(key);
    },

    async project(request: ViewProjectionRequest): Promise<Result<ViewProjection>> {
      const k = kernel;
      const entry = k === null ? undefined : shapes.get(request?.shapeKey);
      if (k === null || entry === undefined) {
        return fail(
          error(
            'INVALID_HANDLE',
            'This part is not loaded in the drawing worker',
            'Load it with loadShape first (the worker may have dropped it).',
          ),
        );
      }
      const facade = toFacadeRequest(request, entry.bounds);
      if (!facade.ok) return facade;
      const started = now();
      let json: string;
      try {
        json = k.project(entry.handle, JSON.stringify(facade.value));
      } catch (e) {
        return poison('project', e);
      }
      const raw = parseResult<RawProjection>(json, 'project');
      if (!raw.ok) return raw;
      const decoded = decodeProjection(
        raw.value,
        entry.edgeNames,
        entry.faceNames,
        facade.value.section !== undefined,
      );
      if (!decoded.ok) return decoded;
      const value: ViewProjection = {
        key: projectionKey(request),
        curves: decoded.value.curves,
        bounds: viewBounds(entry.bounds, facade.value.frame, facade.value.clip),
        ms: now() - started,
      };
      if (decoded.value.sectionFaces !== undefined) value.sectionFaces = decoded.value.sectionFaces;
      return { ok: true, value };
    },

    async releaseShape(key) {
      const v = shapes.delete(key);
      if (v !== undefined) releaseAll([v]);
    },

    async stats() {
      const base = {
        shapes: shapes.size,
        bytes: shapes.bytes,
        liveHandles: kernel?.liveHandleCount() ?? -1,
      };
      return info === null ? base : { ...base, variant: info.variant };
    },
  };
  return api;
}
