/**
 * Spike S0: the mesh exchange shape shared by the native Gmsh script (native/mesh.py) and the Wasm
 * mesher (wasm/): flat arrays, 0-based node indices, Gmsh node order.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { readFileSync } from 'node:fs';

export interface FaceGroup {
  /** Wren persistent face name (the physical group name). */
  name: string;
  /** TopExp face index in the kernel's shape. */
  index: number;
  /** Gmsh surface tag. */
  tag: number;
  /** 6 node indices per quadratic triangle, Gmsh order: corners 0-2, then mid (0,1) (1,2) (2,0). */
  tri6: number[];
}

export interface TetMesh {
  /** xyz triplets, mm. */
  nodes: number[];
  /** 10 node indices per tet, Gmsh order: corners 0-3, mid (0,1) (1,2) (2,0) (3,0) (3,2) (3,1). */
  tet10: number[];
  groups: FaceGroup[];
}

export function loadMesh(path: string): TetMesh {
  return JSON.parse(readFileSync(path, 'utf8')) as TetMesh;
}

export interface WrenFace {
  index: number;
  name: string;
  area: number;
  centroid: [number, number, number];
  normal?: [number, number, number];
  surface: string;
}

export interface FaceList {
  part: string;
  volume: number;
  area: number;
  faces: WrenFace[];
}

export function loadFaces(path: string): FaceList {
  return JSON.parse(readFileSync(path, 'utf8')) as FaceList;
}
