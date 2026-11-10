/**
 * Spike S0: write the CalculiX deck for a meshed Wren part, solve with the local `ccx`, read the
 * .frd and print a JSON summary.
 *
 *   node spikes/simulation/ccx/run.ts <part-dir> <run-name>
 *
 * <part-dir> is out/beam or out/bracket (from export/export.test.ts), <run-name> a mesh run from
 * native/mesh.py or wasm/ (out/<part>/<run>/mesh.json). The study (fixed faces, loads) is chosen
 * by part and refers to faces by their Wren persistent names, picked out of faces.json here.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFrd } from './frd.ts';
import { type Study, writeDeck } from './inp.ts';
import { type FaceList, loadFaces, loadMesh } from './mesh-format.ts';

const [partDir, run] = process.argv.slice(2);
if (!partDir || !run) throw new Error('usage: run.ts <part-dir> <run-name>');
const key = basename(partDir);
const faces = loadFaces(join(partDir, 'faces.json'));
const mat = JSON.parse(readFileSync(join(partDir, 'material.json'), 'utf8')) as {
  name: string;
  density: string;
  properties?: { youngsModulus?: string; poissonsRatio?: string };
};

/** "68.9 GPa" -> MPa; "2.70 g/cm^3" -> tonne/mm^3. Just the units Wren's library uses. */
function mpa(expr: string): number {
  const m = /^\s*([\d.eE+-]+)\s*(GPa|MPa)\s*$/.exec(expr);
  if (!m) throw new Error(`unsupported modulus ${expr}`);
  return Number(m[1]) * (m[2] === 'GPa' ? 1000 : 1);
}
function tonnePerMm3(expr: string): number {
  const m = /^\s*([\d.eE+-]+)\s*g\/cm\^3\s*$/.exec(expr);
  if (!m) throw new Error(`unsupported density ${expr}`);
  return Number(m[1]) * 1e-9;
}
const E = mpa(mat.properties?.youngsModulus ?? '');
const nu = Number(mat.properties?.poissonsRatio);
const material = { name: 'AL6061T6', E, nu, density: tonnePerMm3(mat.density) };

const pick = (f: FaceList, re: RegExp) => f.faces.filter((x) => re.test(x.name));
const one = (xs: { name: string }[], what: string) => {
  if (xs.length !== 1) throw new Error(`needs attention: ${what} matched ${xs.length} faces`);
  return (xs[0] as { name: string }).name;
};

const BEAM = { L: 250, b: 10, h: 10, P: 10 };
let study: Study;
let tipFace: string;
if (key === 'beam') {
  // Clamp the x = 0 end (sketch line L4), shear load -z on the x = L end (sketch line L2).
  const root = one(pick(faces, /:side\(S[^:]+:e\(L4\)\)$/), 'beam root');
  tipFace = one(pick(faces, /:side\(S[^:]+:e\(L2\)\)$/), 'beam tip');
  study = { material, fixed: [root], loads: [{ faces: [tipFace], force: [0, 0, -BEAM.P] }] };
} else {
  // Bolted bracket: the four hole bores fixed, 200 N towards -y on the upright's top face.
  const holes = pick(faces, /:side\(S[^:]+:e\(H[1-4]\)\)$/).map((f) => f.name);
  if (holes.length !== 4) throw new Error('needs attention: expected 4 hole faces');
  const ends = pick(faces, /:end$/).sort((a, b) => b.centroid[2] - a.centroid[2]);
  tipFace = one(ends.slice(0, 1), 'upright top');
  study = { material, fixed: holes, loads: [{ faces: [tipFace], force: [0, -200, 0] }] };
}

const runDir = join(partDir, run);
const mesh = loadMesh(join(runDir, 'mesh.json'));
const deck = writeDeck(mesh, study, `Wren S0 ${key} ${run}`);
writeFileSync(join(runDir, 'job.inp'), deck.deck);
const t0 = performance.now();
execFileSync('nice', ['-n', '19', 'ccx', '-i', 'job'], {
  cwd: runDir,
  env: { ...process.env, OMP_NUM_THREADS: '2' },
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 1 << 26,
});
const solveS = (performance.now() - t0) / 1000;
const frd = parseFrd(readFileSync(join(runDir, 'job.frd'), 'utf8'));

// Nodes of the loaded face (CalculiX ids are mesh index + 1; the frd lists them in order).
const tipGroup = mesh.groups.find((g) => g.name === tipFace);
const tipNodes = new Set((tipGroup?.tri6 ?? []).map((n) => n + 1));
const n = frd.nodeIds.length;
let umax = 0;
let vmMax = 0;
const tipMean = [0, 0, 0];
for (let k = 0; k < n; k++) {
  const u = frd.disp.subarray(3 * k, 3 * k + 3);
  umax = Math.max(umax, Math.hypot(u[0] ?? 0, u[1] ?? 0, u[2] ?? 0));
  vmMax = Math.max(vmMax, frd.vonMises[k] ?? 0);
  if (tipNodes.has(frd.nodeIds[k] ?? -1)) for (let d = 0; d < 3; d++) tipMean[d] += u[d] ?? 0;
}
for (let d = 0; d < 3; d++) tipMean[d] = (tipMean[d] ?? 0) / tipNodes.size;

const summary: Record<string, unknown> = {
  part: key,
  run,
  nodes: n,
  tets: mesh.tet10.length / 10,
  flippedTets: deck.flippedTets,
  fixedNodes: deck.fixedNodes,
  loadedNodes: deck.loadedNodes,
  solveS: Number(solveS.toFixed(2)),
  maxDispMm: umax,
  tipMeanDispMm: tipMean,
  maxVonMisesMPa: vmMax,
};
if (key === 'beam') {
  const I = (BEAM.b * BEAM.h ** 3) / 12;
  const G = E / (2 * (1 + nu));
  const eb = (BEAM.P * BEAM.L ** 3) / (3 * E * I);
  const timo = eb + BEAM.P * BEAM.L / ((5 / 6) * G * BEAM.b * BEAM.h);
  const fe = -(tipMean[2] ?? 0);
  // Bending stress on the top fibre away from both ends: σxx(x) = P (L - x) c / I (tension).
  let ratio = 0;
  let ratioN = 0;
  for (let k = 0; k < n; k++) {
    const x = frd.coords[3 * k] ?? 0;
    const z = frd.coords[3 * k + 2] ?? 0;
    if (x > 0.3 * BEAM.L && x < 0.7 * BEAM.L && Math.abs(z - BEAM.h) < 1e-6) {
      ratio += (frd.stress[6 * k] ?? 0) / ((BEAM.P * (BEAM.L - x) * (BEAM.h / 2)) / I);
      ratioN++;
    }
  }
  Object.assign(summary, {
    eulerBernoulliMm: eb,
    timoshenkoMm: timo,
    errVsEB: fe / eb - 1,
    errVsTimoshenko: fe / timo - 1,
    topFibreSxxOverAnalytic: ratioN ? ratio / ratioN : null,
  });
}
writeFileSync(join(runDir, 'result.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
