/**
 * Sketch worker entry: owns planegcs (Wasm) and exposes exactly `SketchSolverApi` over Comlink.
 * Spawned by `createSketchSolverClient()` as a module worker. The `?url` import makes the bundler
 * emit `planegcs.wasm` as a hashed, self-hosted asset (PLAN §8.3: no CDNs).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { SketchSolverApi } from '@whittle/contracts';
import { expose } from 'comlink';
import { createSketchSolver } from './core';

const solver = createSketchSolver({ wasmUrl });
// Start loading immediately so the first solve doesn't pay for Wasm compilation.
void solver.ready();

const api: SketchSolverApi = {
  solve: (input) => solver.solve(input),
  beginDrag: (input, entity, grab) => solver.beginDrag(input, entity, grab),
  drag: (session, to) => solver.drag(session, to),
  endDrag: (session) => solver.endDrag(session),
  infer: (input, cursor, drawing, tolerance) => solver.infer(input, cursor, drawing, tolerance),
};

expose(api);
