// Spike S0: the Wasm mesher in a browser module worker. Posts {stats} or {error}.
// Message in: { variant, part, size, algo3d }.
self.onmessage = async ({ data: a }) => {
  try {
    const t0 = performance.now();
    const { default: create } = await import(`/build/${a.variant}/out/wren-mesh.js`);
    const m = await create();
    const loadMs = performance.now() - t0;
    const str = (s) => {
      const n = m.lengthBytesUTF8(s) + 1;
      const p = m._malloc(n);
      m.stringToUTF8(s, p, n);
      return p;
    };
    const call = (name, ...xs) => {
      const ps = [];
      const r = m[`_${name}`](
        ...xs.map((x) => {
          if (typeof x !== 'string') return x;
          const p = str(x);
          ps.push(p);
          return p;
        }),
      );
      for (const p of ps) m._free(p);
      if (r === -1) throw new Error(`${name}: ${m.UTF8ToString(m._wm_last_error())}`);
      return r;
    };
    const faces = (await (await fetch(`/out/${a.part}/faces.json`)).json()).faces;
    const brep = new Uint8Array(await (await fetch(`/out/${a.part}/part.brep`)).arrayBuffer());
    m.FS.writeFile('/part.brep', brep);
    call('wm_load_brep', '/part.brep');
    for (const f of faces) call('wm_name_face', f.index, f.name);
    const opts = {
      'Mesh.MeshSizeMax': a.size,
      'Mesh.MeshSizeMin': a.size / 10,
      'Mesh.MeshSizeFromCurvature': 12,
      'Mesh.MeshSizeExtendFromBoundary': 1,
      'Mesh.Algorithm': 6,
      'Mesh.Algorithm3D': a.algo3d,
      'Mesh.SecondOrderLinear': 0,
      'Mesh.Optimize': 1,
    };
    for (const [k, v] of Object.entries(opts)) call('wm_set_option', k, v);
    const t1 = performance.now();
    call('wm_mesh', 2);
    const meshMs = performance.now() - t1;
    const stats = {
      variant: a.variant,
      crossOriginIsolated: self.crossOriginIsolated,
      tets: m._wm_count(1, 0) / 10,
      nodes: m._wm_count(0, 0) / 3,
      loadMs: Math.round(loadMs),
      meshS: Number((meshMs / 1000).toFixed(3)),
      heapPeakMB: Math.round(m.wasmMemory.buffer.byteLength / 2 ** 20),
    };
    m._wm_release();
    self.postMessage({ stats });
  } catch (e) {
    self.postMessage({ error: String(e?.stack ?? e) });
  }
};
