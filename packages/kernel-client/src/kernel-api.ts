/**
 * The kernel worker's `KernelApi` implementation, independent of the worker global so it can be
 * driven directly in Node tests. src/worker.ts wires it to Comlink and the bundled Wasm assets.
 *
 * Responsibilities: variant selection, Wasm loading (streaming compile with download progress),
 * JSON ↔ façade marshalling, copying mesh buffers out of the Wasm heap exactly once and handing
 * them to Comlink as transferables, and converting every JS-side failure into a `KernelError`
 * (a failing call must never crash or poison the worker).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  ExportFormat,
  ExportOptions,
  Feature,
  FeatureInputs,
  FeatureResult,
  Frame,
  KernelApi,
  KernelError,
  KernelErrorCode,
  KernelInfo,
  KernelInitOptions,
  KernelStatus,
  KernelVariant,
  MassProperties,
  Measurement,
  MeshBuffers,
  MeshOptions,
  Result,
  ShapeFingerprints,
  ShapeHandle,
  Vec3,
} from '@wren-cad/contracts';
import {
  type ExactProjectedEdge,
  type ExportShape,
  instantiateKernel,
  type KernelInitModule,
  type KernelModuleOptions,
  type MeasureSubject,
  type RawExportResult,
  type RawImportResult,
  type RawKernelInfo,
  type WhittleKernelModule,
} from '@wren-cad/kernel';
import { transfer } from 'comlink';
import type { ProjectionApi } from './regen/linked';

/** How to obtain one kernel variant. */
export interface VariantSource {
  /** Loads the generated `init.<variant>.js` module (a static `import()` so bundlers see it). */
  load: () => Promise<KernelInitModule>;
  /** Bundler-resolved `.wasm` URL (e.g. from `?url`). Omit to let the glue locate it itself. */
  wasmUrl?: string;
}

export interface KernelApiDeps {
  variants: Record<KernelVariant, VariantSource>;
  /** Lifecycle events for the UI status chip (posted to the main thread by worker.ts). */
  onStatus?: (status: KernelStatus) => void;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to `performance.now()`. */
  now?: () => number;
  /** Capability probe; defaults to `crossOriginIsolated && SharedArrayBuffer`. */
  canUseThreads?: () => boolean;
}

export type {
  ExactProjectedCurve,
  ExactProjectedEdge,
  ExportShape,
  MeasureSubject,
  ProjectedCurve,
  ProjectedEdge,
  ProjectedOutline,
} from '@wren-cad/kernel';

/**
 * A face-outline edge: a `ProjectedEdge` tagged with its loop (0 = the outer loop, k = the k-th
 * inner loop). A flat array, so it also satisfies the regen engine's `ProjectionApi` seam.
 */
export interface ProjectedLoopEdge extends ExactProjectedEdge {
  loop: number;
}

/** One exported file; `bytes` is transferred (never copied) across the worker boundary. */
export interface ExportedFile {
  name: string;
  bytes: Uint8Array;
}

/** Formats `importShapes` reads: every export format plus IGES (M3, import only). */
export type ShapeImportFormat = ExportFormat | 'iges';

/** A body read from an imported file (no mesh yet: call `mesh()`). */
export interface ImportedBody {
  shape: ShapeHandle;
  name?: string;
}

/**
 * Low-level worker surface beyond the contracts' `KernelApi` (M1). The regen engine
 * (`ModelingApi`, packages/kernel-client/src/regen) is built on these. Names avoid
 * `ModelingApi.importFile`/`exportPart`, which work on parts rather than shape handles.
 *
 * The M3 projection calls are the regen engine's `ProjectionApi` seam (optional there, so engine
 * fakes may leave them out); the worker always implements them, with the precise result types
 * of {@link KernelProjectionApi}.
 */
export interface KernelLowLevelApi extends Partial<ProjectionApi> {
  /** Geometric fingerprints of every face/edge/vertex (TopExp order). */
  fingerprints(shape: ShapeHandle): Promise<Result<ShapeFingerprints>>;
  /** Writes STEP/STL/BREP of the given shapes; one file unless STL `stlPerBody`. */
  exportShapes(
    shapes: ExportShape[],
    format: ExportFormat,
    options?: ExportOptions,
  ): Promise<Result<ExportedFile[]>>;
  /**
   * Reads STEP/IGES/BREP/STL bytes into shapes (one per solid; STEP names kept). IGES (M3): loose
   * surfaces are sewn, closed shells become solids and open shells stay shell bodies.
   */
  importShapes(bytes: Uint8Array, format: ShapeImportFormat): Promise<Result<ImportedBody[]>>;
  /** Threaded build: caps OCCT's thread pool (`init({ threads })` applies it automatically). */
  configureThreads(count: number): Promise<Result<{ threads: number; max: number }>>;
  /**
   * M2: exact B-rep measurement of sub-shapes of live shapes and/or world points: one subject
   * gives its intrinsic values, two the minimum distance (+ angle). See whittle_kernel.h.
   */
  measureShapes(a: MeasureSubject, b?: MeasureSubject): Promise<Result<Measurement>>;
}

/** The M3 "convert entities" calls as the kernel worker implements them. */
export interface KernelProjectionApi {
  /**
   * Model edges (TopExp edge ordinals of `shape`) projected onto `plane`, in its local x/y. Lines
   * stay lines, circles and arcs seen face-on stay circles and counter-clockwise arcs, everything
   * else is a `polyline` (approximated); the worker asks for `exact` projections, so conics and
   * B-splines come back as `ellipse` / `ellipticArc` / `bspline`. An edge along the plane normal projects to a point and
   * comes back with no curves.
   */
  projectEdges(
    shape: ShapeHandle,
    edges: number[],
    plane: Frame,
  ): Promise<Result<ExactProjectedEdge[]>>;
  /**
   * A face's outline projected like `projectEdges`: the outer loop's edges (`loop` 0), then each
   * inner loop's (`loop` 1, 2, …), each loop in wire order.
   */
  projectFaceOutline(
    shape: ShapeHandle,
    face: number,
    plane: Frame,
  ): Promise<Result<ProjectedLoopEdge[]>>;
}

/** Everything the kernel worker exposes over Comlink. */
export type KernelWorkerApi = KernelApi & KernelLowLevelApi;

/** Extra surface used by tests and diagnostics; not part of the Comlink contract. */
export interface KernelApiInternals {
  /** Live façade handle count (leak checks). `-1` when not initialised. */
  liveHandleCount(): number;
  /**
   * Bytes of the kernel's Wasm linear memory (its heap; grows on demand, never shrinks). `-1`
   * when not initialised or the build does not export its memory.
   */
  wasmHeapBytes(): number;
}

interface MeshMeta {
  faceNames: string[];
  edgeNames: string[];
  bbox: { min: Vec3; max: Vec3 };
}

const error = (
  code: KernelErrorCode,
  message: string,
  detail?: string,
  hint?: string,
): KernelError => ({
  code,
  message,
  ...(hint === undefined ? {} : { hint }),
  ...(detail === undefined ? {} : { detail }),
});

const fail = <T>(e: KernelError): Result<T> => ({ ok: false, error: e });

/** A transferable, exactly-sized, non-shared copy (no-op when `bytes` already is one). */
function ownedBytes(bytes: Uint8Array): Uint8Array {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes;
  }
  return bytes.slice();
}

let memfsCounter = 0;

const describe = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
};

/** `crossOriginIsolated` alone is not enough in odd hosts; require SharedArrayBuffer too. */
export const defaultCanUseThreads = (): boolean =>
  typeof SharedArrayBuffer !== 'undefined' &&
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

/** Parse a façade `Result` JSON string, guarding against a malformed payload. */
function parseResult<T>(json: string, operation: string): Result<T> {
  try {
    const parsed = JSON.parse(json) as Result<T>;
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.ok === 'boolean')
      return parsed;
  } catch {
    // fall through
  }
  return fail(
    error('INTERNAL', `${operation}: kernel returned a malformed result`, json.slice(0, 200)),
  );
}

/**
 * Wraps a fetch Response body so every chunk reports progress, keeping it streamable for
 * `WebAssembly.instantiateStreaming` (compile overlaps download).
 */
function withProgress(
  response: Response,
  onProgress: (loaded: number, total?: number) => void,
  onDone: () => void,
): Response {
  const header = response.headers.get('content-length');
  const parsedTotal = header === null ? Number.NaN : Number(header);
  // Content-Length is the *encoded* size; with compression it undercounts decoded bytes, so
  // only trust it for identity encoding.
  const encoding = response.headers.get('content-encoding');
  const total =
    Number.isFinite(parsedTotal) &&
    parsedTotal > 0 &&
    (encoding === null || encoding === 'identity')
      ? parsedTotal
      : undefined;
  if (response.body === null) {
    onDone();
    return response;
  }
  let loaded = 0;
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        onDone();
        controller.close();
        return;
      }
      loaded += value.byteLength;
      onProgress(loaded, total);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/wasm' },
  });
}

export function createKernelApi(
  deps: KernelApiDeps,
): KernelProjectionApi & KernelWorkerApi & KernelApiInternals {
  const now = deps.now ?? (() => performance.now());
  const emit = (status: KernelStatus) => {
    try {
      deps.onStatus?.(status);
    } catch {
      // A broken listener must not break the kernel.
    }
  };

  let kernel: WhittleKernelModule | null = null;
  let info: KernelInfo | null = null;
  let pending: Promise<Result<KernelInfo>> | null = null;
  /** Set after a Wasm trap: the instance may be inconsistent, so require a fresh init(). */
  let poisoned: KernelError | null = null;

  const notReady = <T>(): Result<T> =>
    fail(
      poisoned ??
        error(
          'NOT_INITIALISED',
          'The geometry kernel is not ready yet',
          undefined,
          'Call init() first.',
        ),
    );

  /** Converts an escaped JS/Wasm exception into a Result, poisoning the instance on traps. */
  const caught = <T>(operation: string, e: unknown): Result<T> => {
    if (e instanceof WebAssembly.RuntimeError) {
      poisoned = error(
        'INTERNAL',
        'The geometry kernel crashed and must be restarted',
        describe(e),
        'The kernel will reload on the next init().',
      );
      kernel = null;
      info = null;
      emit({ state: 'error', error: poisoned });
      return fail(error('INTERNAL', `${operation} crashed the geometry kernel`, describe(e)));
    }
    return fail(error('INTERNAL', `${operation} failed unexpectedly`, describe(e)));
  };

  async function load(options: KernelInitOptions): Promise<Result<KernelInfo>> {
    const started = now();
    const canThread = (deps.canUseThreads ?? defaultCanUseThreads)();
    const variant: KernelVariant = options.variant ?? (canThread ? 'threaded' : 'single');
    if (variant === 'threaded' && typeof SharedArrayBuffer === 'undefined') {
      const e = error(
        'INVALID_INPUT',
        'The threaded kernel needs SharedArrayBuffer (cross-origin isolation)',
        undefined,
        'Use the single-threaded kernel, or serve the app with COOP/COEP headers.',
      );
      emit({ state: 'error', error: e });
      return fail(e);
    }
    const source = deps.variants[variant];
    const wasmUrl = options.wasmUrl ?? source.wasmUrl;
    // Async failures inside Emscripten's instantiateWasm hook surface here instead of hanging.
    let rejectLoad: (e: unknown) => void = () => {};
    const loadFailed = new Promise<never>((_, reject) => {
      rejectLoad = reject;
    });
    try {
      const moduleOptions: KernelModuleOptions & { threadCount?: number } = {};
      const threads = options.threads;
      if (variant === 'threaded' && threads !== undefined) {
        if (!Number.isInteger(threads) || threads < 1) {
          const e = error('INVALID_INPUT', 'threads must be a positive integer');
          emit({ state: 'error', error: e });
          return fail(e);
        }
        moduleOptions.threadCount = threads;
      }
      let streaming = false;
      if (wasmUrl !== undefined) {
        moduleOptions.locateFile = (path, prefix) =>
          path.endsWith('.wasm') ? wasmUrl : `${prefix}${path}`;
        const fetchImpl = deps.fetch ?? globalThis.fetch;
        if (
          typeof fetchImpl === 'function' &&
          typeof WebAssembly.instantiateStreaming === 'function'
        ) {
          streaming = true;
          moduleOptions.instantiateWasm = (imports, receiveInstance) => {
            emit({ state: 'downloading', loaded: 0 });
            fetchImpl(wasmUrl, { credentials: 'same-origin' })
              .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${wasmUrl}`);
                const tracked = withProgress(
                  response,
                  (loaded, total) =>
                    emit(
                      total === undefined
                        ? { state: 'downloading', loaded }
                        : { state: 'downloading', loaded, total },
                    ),
                  () => emit({ state: 'compiling' }),
                );
                // Streaming compile: compilation overlaps the download.
                return WebAssembly.instantiateStreaming(tracked, imports);
              })
              .then(({ instance, module }) => {
                receiveInstance(instance, module);
              })
              .catch((e: unknown) => {
                rejectLoad(e);
              });
            return {}; // async instantiation: Emscripten waits for receiveInstance
          };
        }
      }
      const init = await source.load();
      if (!streaming) emit({ state: 'compiling' });
      const instance = await Promise.race([instantiateKernel(init, moduleOptions), loadFailed]);
      const raw = parseResult<RawKernelInfo>(instance.kernelInfo(), 'kernelInfo');
      if (!raw.ok) {
        emit({ state: 'error', error: raw.error });
        return raw;
      }
      if (raw.value.threads !== (variant === 'threaded')) {
        const e = error(
          'INTERNAL',
          `Loaded kernel does not match the requested ${variant} variant`,
        );
        emit({ state: 'error', error: e });
        return fail(e);
      }
      if (variant === 'threaded' && threads !== undefined) {
        // Keep OCCT's pool within the pthread pool the module was started with.
        const configured = parseResult<unknown>(
          instance.configureThreads(threads),
          'configureThreads',
        );
        if (!configured.ok) {
          emit({ state: 'error', error: configured.error });
          return configured;
        }
      }
      kernel = instance;
      poisoned = null;
      info = {
        variant,
        occtVersion: raw.value.occtVersion,
        buildId: raw.value.buildId,
        initMs: now() - started,
      };
      emit({ state: 'ready', info });
      return { ok: true, value: info };
    } catch (e) {
      const err = error('INTERNAL', `Failed to load the ${variant} geometry kernel`, describe(e));
      emit({ state: 'error', error: err });
      return fail(err);
    }
  }

  const api: KernelProjectionApi & KernelWorkerApi & KernelApiInternals = {
    init(options: KernelInitOptions = {}): Promise<Result<KernelInfo>> {
      if (kernel !== null && info !== null) {
        const sameVariant = options.variant === undefined || options.variant === info.variant;
        if (sameVariant) return Promise.resolve({ ok: true, value: info });
        return Promise.resolve(
          fail(
            error(
              'INVALID_INPUT',
              `The ${info.variant} kernel is already loaded`,
              undefined,
              'Start a new kernel worker to switch variants.',
            ),
          ),
        );
      }
      if (pending === null) {
        pending = load(options).finally(() => {
          pending = null;
        });
      }
      return pending;
    },

    async execFeature(feature: Feature, inputs: FeatureInputs): Promise<Result<FeatureResult>> {
      if (kernel === null) return notReady();
      try {
        return parseResult<FeatureResult>(
          kernel.execFeature(JSON.stringify(feature), JSON.stringify(inputs)),
          'execFeature',
        );
      } catch (e) {
        return caught('execFeature', e);
      }
    },

    async mesh(shape: ShapeHandle, options: MeshOptions): Promise<Result<MeshBuffers>> {
      if (kernel === null) return notReady();
      let data: InstanceType<WhittleKernelModule['MeshData']> | null = null;
      try {
        data = new kernel.MeshData();
        const status = parseResult<Record<string, never>>(
          kernel.mesh(shape, JSON.stringify(options), data),
          'mesh',
        );
        if (!status.ok) return status;
        // One copy out of the Wasm heap per buffer: slice() allocates a fresh, non-shared
        // ArrayBuffer (also for the threaded build's SharedArrayBuffer heap). Each view is
        // copied before the next call, so heap growth cannot invalidate it.
        const buffers: MeshBuffers = {
          positions: data.positions().slice(),
          normals: data.normals().slice(),
          indices: data.indices().slice(),
          faceRanges: data.faceRanges().slice(),
          edgePositions: data.edgePositions().slice(),
          edgeRanges: data.edgeRanges().slice(),
          faceNames: [],
          edgeNames: [],
          bbox: { min: [0, 0, 0], max: [0, 0, 0] },
        };
        const meta = JSON.parse(data.metaJson()) as MeshMeta;
        buffers.faceNames = meta.faceNames;
        buffers.edgeNames = meta.edgeNames;
        buffers.bbox = meta.bbox;
        const result: Result<MeshBuffers> = { ok: true, value: buffers };
        return transfer(result, [
          buffers.positions.buffer,
          buffers.normals.buffer,
          buffers.indices.buffer,
          buffers.faceRanges.buffer,
          buffers.edgePositions.buffer,
          buffers.edgeRanges.buffer,
        ] as ArrayBuffer[]);
      } catch (e) {
        return caught('mesh', e);
      } finally {
        try {
          data?.delete();
        } catch {
          // Instance already gone (e.g. after a trap); nothing to free.
        }
      }
    },

    async massProperties(shape: ShapeHandle, density?: number): Promise<Result<MassProperties>> {
      if (kernel === null) return notReady();
      if (density !== undefined && !(Number.isFinite(density) && density > 0)) {
        return fail(
          error(
            'INVALID_INPUT',
            'Density must be a positive number',
            String(density),
            "Check the part material's density.",
          ),
        );
      }
      try {
        return parseResult<MassProperties>(
          kernel.massProperties(shape, density ?? 0),
          'massProperties',
        );
      } catch (e) {
        return caught('massProperties', e);
      }
    },

    async fingerprints(shape: ShapeHandle): Promise<Result<ShapeFingerprints>> {
      if (kernel === null) return notReady();
      try {
        return parseResult<ShapeFingerprints>(kernel.fingerprints(shape), 'fingerprints');
      } catch (e) {
        return caught('fingerprints', e);
      }
    },

    async exportShapes(
      shapes: ExportShape[],
      format: ExportFormat,
      options: ExportOptions = {},
    ): Promise<Result<ExportedFile[]>> {
      if (kernel === null) return notReady();
      const k = kernel;
      let paths: string[] = [];
      try {
        const written = parseResult<RawExportResult>(
          k.exportShapes(JSON.stringify(shapes), format, JSON.stringify(options)),
          'exportShapes',
        );
        if (!written.ok) return written;
        paths = written.value.files.map((f) => f.path);
        // MEMFS → JS once; the bytes are then transferred to the caller.
        const files = written.value.files.map((f) => ({
          name: f.name,
          bytes: ownedBytes(k.FS.readFile(f.path, { encoding: 'binary' })),
        }));
        const result: Result<ExportedFile[]> = { ok: true, value: files };
        return transfer(
          result,
          files.map((f) => f.bytes.buffer as ArrayBuffer),
        );
      } catch (e) {
        return caught('exportShapes', e);
      } finally {
        for (const path of paths) {
          try {
            k.FS.unlink(path);
          } catch {
            // Already gone (e.g. after a trap).
          }
        }
      }
    },

    async importShapes(
      bytes: Uint8Array,
      format: ShapeImportFormat,
    ): Promise<Result<ImportedBody[]>> {
      if (kernel === null) return notReady();
      const k = kernel;
      memfsCounter += 1;
      const path = `/tmp/wren-import-${memfsCounter}.${format}`;
      let written = false;
      try {
        k.FS.writeFile(path, bytes);
        written = true;
        const read = parseResult<RawImportResult>(k.importFile(path, format), 'importFile');
        if (!read.ok) return read;
        return { ok: true, value: read.value.bodies };
      } catch (e) {
        return caught('importShapes', e);
      } finally {
        if (written) {
          try {
            k.FS.unlink(path);
          } catch {
            // Already gone.
          }
        }
      }
    },

    async configureThreads(count: number): Promise<Result<{ threads: number; max: number }>> {
      if (kernel === null) return notReady();
      try {
        return parseResult<{ threads: number; max: number }>(
          kernel.configureThreads(count),
          'configureThreads',
        );
      } catch (e) {
        return caught('configureThreads', e);
      }
    },

    async measureShapes(a: MeasureSubject, b?: MeasureSubject): Promise<Result<Measurement>> {
      if (kernel === null) return notReady();
      try {
        return parseResult<Measurement>(
          kernel.measure(JSON.stringify(b === undefined ? { a } : { a, b })),
          'measure',
        );
      } catch (e) {
        return caught('measure', e);
      }
    },

    async projectEdges(
      shape: ShapeHandle,
      edges: number[],
      plane: Frame,
    ): Promise<Result<ExactProjectedEdge[]>> {
      if (kernel === null) return notReady();
      try {
        return parseResult<ExactProjectedEdge[]>(
          // `exact`: conics and B-splines come back as exact ellipse / ellipticArc / bspline curves
          // (M3.5, ADR-056), which become exact linked entities, not polylines.
          kernel.projectEdges(JSON.stringify({ shape, edges, plane, exact: true })),
          'projectEdges',
        );
      } catch (e) {
        return caught('projectEdges', e);
      }
    },

    async projectFaceOutline(
      shape: ShapeHandle,
      face: number,
      plane: Frame,
    ): Promise<Result<ProjectedLoopEdge[]>> {
      if (kernel === null) return notReady();
      try {
        const raw = parseResult<{ outer: ExactProjectedEdge[]; inner: ExactProjectedEdge[][] }>(
          kernel.projectFaceOutline(JSON.stringify({ shape, face, plane, exact: true })),
          'projectFaceOutline',
        );
        if (!raw.ok) return raw;
        const edges: ProjectedLoopEdge[] = raw.value.outer.map((e) => ({ ...e, loop: 0 }));
        raw.value.inner.forEach((loop, i) => {
          for (const e of loop) edges.push({ ...e, loop: i + 1 });
        });
        return { ok: true, value: edges };
      } catch (e) {
        return caught('projectFaceOutline', e);
      }
    },

    async release(shape: ShapeHandle): Promise<void> {
      if (kernel === null) return;
      try {
        kernel.release(shape);
      } catch (e) {
        caught('release', e);
      }
    },

    liveHandleCount(): number {
      if (kernel === null) return -1;
      try {
        return kernel.liveHandleCount();
      } catch {
        return -1;
      }
    },

    wasmHeapBytes(): number {
      // `wasmMemory` is not among the checked façade entry points: guard against its absence.
      const memory: WebAssembly.Memory | undefined = kernel?.wasmMemory;
      return memory ? memory.buffer.byteLength : -1;
    },
  };
  return api;
}
