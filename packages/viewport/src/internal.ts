import type {
  BodyDisplay,
  Marker,
  MeshBuffers,
  PreviewSpec,
  SketchOverlay,
  Vec3,
} from '@wren-cad/contracts';
import type { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import type {
  BufferGeometry,
  Group,
  Line2NodeMaterial,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import type { MeshBVH } from 'three-mesh-bvh';
import type { FaceIdLayout } from './ids';
import type { Dot } from './overlays';
import type { MeshPreview, PrismPreview } from './preview';
import type { Bounds } from './views';
import type { WheelAnchor, ZoomFrame } from './zoom';

export const FOV_DEG = 35;
export const DEFAULT_BODY_COLOR_KEY = 'default';
/** ID buffer resolution relative to the canvas' CSS size. */
export const ID_SCALE = 0.5;
export const DEFAULT_TOLERANCE_PX = 6;
/** Faces above this many triangles are ray-cast through the BVH instead of brute force. */
export const LARGE_FACE_TRIANGLES = 20_000;
/** Orbit start builds a missing BVH synchronously only below this many visible triangles. */
export const NAV_SYNC_BVH_TRIANGLES = 150_000;
/** The wheel pick may build a BVH synchronously only below this size (about 10 ms). */
export const WHEEL_SYNC_BVH_TRIANGLES = 30_000;

/** Edge occlusion samples, as fractions of the polyline length. */
export const EDGE_SAMPLE_FRACTIONS = [0.5, 0.25, 0.75];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Wheel zoom in progress: the camera slides along the cursor ray toward `anchor`. */
export interface WheelState {
  anchor: WheelAnchor;
  frame: ZoomFrame;
  /** Eased distance to the anchor, and the distance the notches asked for. */
  current: number;
  goal: number;
  min: number;
  max: number;
  /** Where this code last put the camera: a different pose means someone else moved it. */
  lastPos: Vec3;
  settled: boolean;
}

export interface BodyEntry {
  group: Group;
  object: Mesh;
  lines: LineSegments2 | null;
  material: MeshStandardNodeMaterial;
  geometry: BufferGeometry;
  buffers: MeshBuffers;
  triangles: number;
  bounds: Bounds;
  display: Required<BodyDisplay>;
  // lazily built picking data
  bvh: MeshBVH | null;
  triFace: Uint32Array | null;
  vertices: Float32Array | null;
  faceLayout: FaceIdLayout | null;
  idMesh: Mesh | null;
  /** Global id base the id colours were built with (-1 = not built). */
  idBuiltBase: number;
  idBase: number;
  /** Stencil section cap passes; built lazily when a section with caps is active. */
  cap: CapSet | null;
}

export interface CapSet {
  back: Mesh;
  front: Mesh;
  quad: Mesh;
  backMat: MeshBasicNodeMaterial;
  frontMat: MeshBasicNodeMaterial;
  quadMat: MeshBasicNodeMaterial;
}

export type PreviewEntry =
  | {
      kind: 'prism';
      view: PrismPreview;
      bodyId: string;
      faces: number[];
      buffers: MeshBuffers;
      spec: Extract<PreviewSpec, { kind: 'prism' }>;
    }
  | { kind: 'mesh'; view: MeshPreview };

export interface MarkerEntry {
  group: Group;
  dots: Dot[];
  markers: Marker[];
}

export interface GhostEntry {
  group: Group;
  material: MeshStandardNodeMaterial;
  lineMaterial: Line2NodeMaterial | null;
}

export interface SketchEntry {
  overlay: SketchOverlay;
  group: Group;
  dots: Dot[];
  /** Per-curve data for picking. */
  curves: Array<{ entity: string; points: Float32Array; isPoint: boolean }>;
  regions: Array<{ name: string; mesh: MeshBuffers }>;
}

export const DEFAULT_DISPLAY: Required<BodyDisplay> = {
  color: DEFAULT_BODY_COLOR_KEY,
  visible: true,
  opacity: 1,
};

/**
 * Event creation time on the performance.now() clock. Using it (not "now at handling") keeps tap
 * and double-tap timing right when the main thread stalls and events queue up. Falls back to
 * `performance.now()` for events with an implausible timestamp.
 */
export function inputPending(): boolean {
  const s = (navigator as Navigator & { scheduling?: { isInputPending?(): boolean } }).scheduling;
  try {
    return s?.isInputPending?.() === true;
  } catch {
    return false;
  }
}

export function eventTime(e: Event): number {
  const now = performance.now();
  const t = e.timeStamp;
  return t > 0 && Math.abs(now - t) < 10_000 && t <= now + 1 ? t : now;
}

export function sameFaces(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function stripUndefined(d: BodyDisplay): BodyDisplay {
  const out: BodyDisplay = {};
  if (d.color !== undefined) out.color = d.color;
  if (d.visible !== undefined) out.visible = d.visible;
  if (d.opacity !== undefined) out.opacity = d.opacity;
  return out;
}
