/**
 * Typed JS surface of the drawing kernel (drawing/cpp/wren_drawing_bindings.cpp), the trimmed HLR
 * build of ADR-090's amendment. Hand-maintained like ../facade.ts: the toolchain generates no
 * declarations for raw embind bindings. Structured values cross as JSON `Result<T>` strings.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Curve2, EdgeClass, LineRole, Vec2, Vec3 } from '@wren-cad/contracts';
import type { KernelFileSystem, KernelModuleOptions } from '../facade';

/** The façade functions registered on the drawing module (see wren_drawing.h). */
export interface DrawingKernelModule {
  /** `Result<RawDrawingInfo>` JSON. */
  drawingInfo(): string;
  /** Reads a BREP file from MEMFS. `Result<RawLoadedShape>` JSON. */
  loadShape(path: string): string;
  /** `Result<RawProjection>` JSON; `requestJson` is a {@link FacadeProjectRequest}. */
  project(shape: number, requestJson: string): string;
  /** Threaded build: caps OCCT's thread pool. `Result<{threads, max}>` JSON. */
  configureThreads(count: number): string;
  release(shape: number): void;
  liveHandleCount(): number;
  FS: KernelFileSystem;
  wasmMemory: WebAssembly.Memory;
}

export interface RawDrawingInfo {
  occtVersion: string;
  buildId: string;
  threads: boolean;
  kind: 'drawing';
}

export interface RawLoadedShape {
  handle: number;
  /** TopExp edge / face counts of the loaded BREP: `edgeNames` / `faceNames` must match them. */
  edges: number;
  faces: number;
  solids: number;
}

/** What `project` receives (built by request.ts from a contracts `ViewProjectionRequest`). */
export interface FacadeProjectRequest {
  /** Orthonormal view right / up. */
  frame: { x: Vec3; y: Vec3 };
  quality: 'draft' | 'exact';
  hidden: boolean;
  smooth: boolean;
  /** Draft tessellation (mm, rad). */
  linearDeflection: number;
  angularDeflection: number;
  /** Chord tolerance (mm) of curves without an exact 2D form. */
  sampleTolerance: number;
  section?: { cut: Vec3[]; along: Vec3; look: Vec3; depth: 'full' | 'slice' };
  clip?: { center: Vec2; radius: number };
}

/** One projected curve as the façade returns it: `index` is the input edge (TopExp), −1 = none. */
export interface RawProjectedCurve {
  role: LineRole;
  edge: EdgeClass;
  index: number;
  /**
   * Outlines and seams on a silhouette: the input face (TopExp) whose silhouette this is;
   * −1 = none.
   * Absent from façades built before the ADR-090 second gate round (read as −1).
   */
  face?: number;
  curve: Curve2;
}

export interface RawProjection {
  curves: RawProjectedCurve[];
  /** Cut faces in a deterministic order: per cut segment, by the centre of their box in the view. */
  sectionFaces: { segment: number; loops: Curve2[][] }[];
  stats: { hlrMs: number; cutMs: number; edges: number; faces: number };
}

/** Shape of the generated `drawing/dist/init.<variant>.js` modules. */
export interface DrawingInitModule {
  createInstance(options?: KernelModuleOptions & { threadCount?: number }): Promise<unknown>;
}

const REQUIRED = [
  'drawingInfo',
  'loadShape',
  'project',
  'configureThreads',
  'release',
  'liveHandleCount',
] as const;

/**
 * Instantiates a drawing kernel variant and narrows it to the façade surface. Throws when the
 * module lacks an entry point (a stale or foreign build, such as the main kernel).
 */
export async function instantiateDrawingKernel(
  init: DrawingInitModule,
  options: KernelModuleOptions & { threadCount?: number } = {},
): Promise<DrawingKernelModule> {
  const instance = (await init.createInstance(options)) as Partial<DrawingKernelModule>;
  for (const name of REQUIRED) {
    if (typeof instance[name] !== 'function') {
      throw new Error(`Drawing kernel module is missing façade entry point "${name}"`);
    }
  }
  return instance as DrawingKernelModule;
}

/** Emitted artefact base names per variant (drawing/libcascade.config.ts). */
export const DRAWING_ARTEFACT = {
  single: 'wren-drawing-st',
  threaded: 'wren-drawing',
} as const;
