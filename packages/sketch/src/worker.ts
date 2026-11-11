/**
 * Sketch worker entry: owns planegcs (Wasm) and exposes exactly `SketchSolverApi` over Comlink.
 * Spawned by `createSketchSolverClient()` as a module worker. The `?url` import makes the bundler
 * emit `planegcs.wasm` as a hashed, self-hosted asset (PLAN §8.3: no CDNs).
 *
 * Besides Comlink it posts one plain message once planegcs is loaded (`SKETCH_WORKER_READY`) or
 * failed to load (`SKETCH_WORKER_FAILED`): the client's call deadlines start only then, so a slow
 * Wasm download is never taken for a hung worker (ADR-088 amendment). Comlink ignores messages
 * without its `id`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { SketchSolverApi } from '@wren-cad/contracts';
import { expose } from 'comlink';
import { createSketchSolver } from './core';
import { SKETCH_WORKER_FAILED, SKETCH_WORKER_READY } from './worker-protocol';

const solver = createSketchSolver({ wasmUrl });
// Start loading immediately so the first solve doesn't pay for Wasm compilation.
solver.ready().then(
  () => self.postMessage({ wrenSketch: SKETCH_WORKER_READY }),
  (err: unknown) =>
    self.postMessage({
      wrenSketch: SKETCH_WORKER_FAILED,
      message: err instanceof Error ? err.message : String(err),
    }),
);

const api: SketchSolverApi = {
  solve: (input) => solver.solve(input),
  beginDrag: (input, entity, grab) => solver.beginDrag(input, entity, grab),
  drag: (session, to) => solver.drag(session, to),
  endDrag: (session) => solver.endDrag(session),
  infer: (input, cursor, drawing, tolerance) => solver.infer(input, cursor, drawing, tolerance),
};

expose(api);
