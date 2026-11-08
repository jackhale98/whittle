/**
 * The kernel worker's `KernelApi` implementation, independent of the worker global so it can be
 * driven directly in Node tests. src/worker.ts wires it to Comlink and the bundled Wasm assets.
 *
 * Responsibilities: variant selection, Wasm loading (streaming compile with download progress),
 * JSON ↔ façade marshalling, copying mesh buffers out of the Wasm heap exactly once and handing
 * them to Comlink as transferables, and converting every JS-side failure into a `KernelError`
 * (a failing call must never crash or poison the worker).
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Feature,
  FeatureInputs,
  FeatureResult,
  KernelApi,
  KernelError,
  KernelErrorCode,
  KernelInfo,
  KernelInitOptions,
  KernelStatus,
  KernelVariant,
  MassProperties,
  MeshBuffers,
  MeshOptions,
  Result,
  ShapeHandle,
  Vec3,
} from '@whittle/contracts';
import {
  instantiateKernel,
  type KernelInitModule,
  type KernelModuleOptions,
  type RawKernelInfo,
  type WhittleKernelModule,
} from '@whittle/kernel';
import { transfer } from 'comlink';

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

/** Extra surface used by tests and diagnostics; not part of the Comlink contract. */
export interface KernelApiInternals {
  /** Live façade handle count (leak checks). `-1` when not initialised. */
  liveHandleCount(): number;
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

export function createKernelApi(deps: KernelApiDeps): KernelApi & KernelApiInternals {
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
      const moduleOptions: KernelModuleOptions = {};
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

  const api: KernelApi & KernelApiInternals = {
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

    async massProperties(shape: ShapeHandle): Promise<Result<MassProperties>> {
      if (kernel === null) return notReady();
      try {
        return parseResult<MassProperties>(kernel.massProperties(shape), 'massProperties');
      } catch (e) {
        return caught('massProperties', e);
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
  };
  return api;
}
