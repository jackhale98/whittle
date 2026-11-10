// Spike S0: run the Wasm Gmsh (build/<variant>/out/wren-mesh.js) in a Node worker thread on an
// exported Wren part and measure it. Same mesh options as native/mesh.py, so the two can be
// compared; writes out/<part>/<run>/{stats.json, mesh.json} (mesh.json in the TetMesh shape that
// ccx/run.ts reads, so a Wasm mesh can be solved too).
//
//   node spikes/simulation/wasm/mesh-node.mjs <part-dir> <run> --size H [--algo3d 1|10]
//        [--variant single|multi] [--no-json]
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const here = fileURLToPath(new URL('.', import.meta.url));

function args(argv) {
  const a = { size: 0, algo3d: 1, variant: 'single', json: true, curv: 12 };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--size') a.size = Number(argv[++i]);
    else if (v === '--algo3d') a.algo3d = Number(argv[++i]);
    else if (v === '--variant') a.variant = argv[++i];
    else if (v === '--curv') a.curv = Number(argv[++i]);
    else if (v === '--no-json') a.json = false;
    else pos.push(v);
  }
  [a.partDir, a.run] = pos;
  if (!a.partDir || !a.run || !(a.size > 0)) throw new Error('usage: <part-dir> <run> --size H');
  return a;
}

async function work(a) {
  const t0 = performance.now();
  const glue = join(here, '..', 'build', a.variant, 'out', 'wren-mesh.js');
  const { default: create } = await import(pathToFileURL(glue).href);
  const m = await create();
  const loadMs = performance.now() - t0;
  const heap0 = m.wasmMemory.buffer.byteLength;

  const str = (s) => {
    const n = m.lengthBytesUTF8(s) + 1;
    const p = m._malloc(n);
    m.stringToUTF8(s, p, n);
    return p;
  };
  const call = (name, ...xs) => {
    const ptrs = [];
    const conv = xs.map((x) => {
      if (typeof x !== 'string') return x;
      const p = str(x);
      ptrs.push(p);
      return p;
    });
    const r = m[`_${name}`](...conv);
    for (const p of ptrs) m._free(p);
    if (r === -1) throw new Error(`${name}: ${m.UTF8ToString(m._wm_last_error())}`);
    return r;
  };

  const faces = JSON.parse(readFileSync(join(a.partDir, 'faces.json'), 'utf8')).faces;
  m.FS.writeFile('/part.brep', readFileSync(join(a.partDir, 'part.brep')));
  const nf = call('wm_load_brep', '/part.brep');
  if (nf !== faces.length) throw new Error(`face count ${nf} vs ${faces.length}`);
  const tagIsTopExp = faces.every((f) => m._wm_face_tag(f.index) === f.index + 1);
  for (const f of faces) call('wm_name_face', f.index, f.name);
  const opts = {
    'Mesh.MeshSizeMax': a.size,
    'Mesh.MeshSizeMin': a.size / 10,
    'Mesh.MeshSizeFromCurvature': a.curv,
    'Mesh.MeshSizeExtendFromBoundary': 1,
    'Mesh.Algorithm': 6,
    'Mesh.Algorithm3D': a.algo3d,
    'Mesh.SecondOrderLinear': 0,
    'Mesh.Optimize': 1,
    'General.NumThreads': 1,
    'Mesh.MaxNumThreads3D': 1,
  };
  for (const [k, v] of Object.entries(opts)) call('wm_set_option', k, v);
  const t1 = performance.now();
  call('wm_mesh', 2);
  const meshMs = performance.now() - t1;
  const heapPeak = m.wasmMemory.buffer.byteLength; // memory only grows: final size = peak

  const buf = m.wasmMemory.buffer;
  const nodes = new Float64Array(buf, m._wm_ptr(0, 0), m._wm_count(0, 0));
  const tets = new Uint32Array(buf, m._wm_ptr(1, 0), m._wm_count(1, 0));
  const groups = faces.map((f, g) => ({
    name: m.UTF8ToString(m._wm_ptr(3, g)),
    index: f.index,
    tag: m._wm_face_tag(f.index),
    tri6: Array.from(new Uint32Array(buf, m._wm_ptr(2, g), m._wm_count(2, g))),
  }));
  const stats = {
    variant: a.variant,
    gmsh: m.UTF8ToString(m._wm_version()),
    size: a.size,
    algo3d: a.algo3d,
    nodes: nodes.length / 3,
    tets: tets.length / 10,
    surfaceTris: groups.reduce((s, g) => s + g.tri6.length / 6, 0),
    loadMs: Math.round(loadMs),
    meshS: Number((meshMs / 1000).toFixed(3)),
    heapInitialMB: Math.round(heap0 / 2 ** 20),
    heapPeakMB: Math.round(heapPeak / 2 ** 20),
    minSICN: Number(m._wm_min_sicn().toFixed(4)),
    tagOrderIsTopExp: tagIsTopExp,
    namesRoundTrip: groups.every((g, i) => g.name === faces[i].name),
  };
  const mesh = a.json ? { nodes: Array.from(nodes), tet10: Array.from(tets), groups } : null;
  m._wm_release();
  return { stats, mesh };
}

if (isMainThread) {
  const a = args(process.argv.slice(2));
  const w = new Worker(fileURLToPath(import.meta.url), { workerData: a });
  w.on('message', ({ stats, mesh }) => {
    stats.processPeakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
    const dir = join(a.partDir, a.run);
    mkdirSync(dir, { recursive: true });
    if (mesh) writeFileSync(join(dir, 'mesh.json'), JSON.stringify(mesh));
    writeFileSync(join(dir, 'stats.json'), JSON.stringify(stats, null, 1));
    console.log(JSON.stringify(stats));
  });
  w.on('error', (e) => {
    console.error(e);
    process.exitCode = 1;
  });
} else {
  work(workerData).then(
    (r) => parentPort.postMessage(r),
    (e) => {
      throw e;
    },
  );
}
