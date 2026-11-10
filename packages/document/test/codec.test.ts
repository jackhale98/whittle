// SPDX-License-Identifier: GPL-3.0-or-later
import type { ProjectFiles, WrenDoc } from '@wren-cad/contracts';
import { SCHEMA_VERSION } from '@wren-cad/contracts';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  assignSlugs,
  canonicalJson,
  fromFiles,
  MANIFEST_FILE,
  newDoc,
  PARAMS_FILE,
  ProjectFormatError,
  packFiles,
  projectCodec,
  slugify,
  toFiles,
  unpackFiles,
} from '../src';
import { box, id, sampleDoc } from './fixtures';

const text = (files: ProjectFiles, path: string) => strFromU8(files.get(path) as Uint8Array);

/** Rebuilds `v` with object keys inserted in a seeded-random order (deeply). */
function shuffleKeys(v: unknown, rnd: () => number): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, rnd));
  if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = shuffleKeys((v as Record<string, unknown>)[k], rnd);
    return out;
  }
  return v;
}

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('canonicalJson', () => {
  it('sorts keys, indents by 2, uses LF and ends with a newline', () => {
    const out = canonicalJson({ b: 1, a: [1, { d: true, c: null }], e: 'x', f: {}, g: [] });
    expect(out).toBe(
      [
        '{',
        '  "a": [',
        '    1,',
        '    {',
        '      "c": null,',
        '      "d": true',
        '    }',
        '  ],',
        '  "b": 1,',
        '  "e": "x",',
        '  "f": {},',
        '  "g": []',
        '}',
        '',
      ].join('\n'),
    );
    expect(out).not.toContain('\r');
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('is valid JSON that round-trips', () => {
    const doc = sampleDoc();
    expect(JSON.parse(canonicalJson(doc))).toEqual(doc);
  });

  it('drops undefined properties, normalises -0, escapes strings', () => {
    expect(canonicalJson({ a: undefined, b: -0, c: 'q"\n\u2028é' })).toBe(
      '{\n  "b": 0,\n  "c": "q\\"\\n\u2028é"\n}\n',
    );
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/Non-finite/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/Non-finite/);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
  });

  it('survives hostile keys', () => {
    const o = JSON.parse('{"__proto__": {"x": 1}, "a": 1}');
    expect(canonicalJson(o)).toBe('{\n  "__proto__": {\n    "x": 1\n  },\n  "a": 1\n}\n');
  });

  it('property: key insertion order never changes the bytes', () => {
    const doc = sampleDoc();
    const reference = canonicalJson(doc);
    const refFiles = toFiles(doc);
    for (let seed = 1; seed <= 60; seed++) {
      const shuffled = shuffleKeys(doc, lcg(seed)) as WrenDoc;
      expect(canonicalJson(shuffled)).toBe(reference);
      const files = toFiles(shuffled);
      expect([...files.keys()]).toEqual([...refFiles.keys()]);
      for (const [k, v] of refFiles) expect(files.get(k)).toEqual(v);
    }
  });
});

describe('slugs', () => {
  it('slugify is ASCII, lowercase and never empty', () => {
    expect(slugify('Bracket – Left (v2)', 'part')).toBe('bracket-left-v2');
    expect(slugify('Ünïcödé Plate', 'part')).toBe('unicode-plate');
    expect(slugify('  ', 'part')).toBe('part');
    expect(slugify('日本語', 'part')).toBe('part');
    expect(slugify('a'.repeat(100), 'part')).toHaveLength(64);
    expect(slugify('../../etc/passwd', 'part')).toBe('etc-passwd');
  });

  it('duplicates are disambiguated by id, independent of array order', () => {
    const items = [
      { id: 'B', name: 'Plate' },
      { id: 'A', name: 'Plate' },
      { id: 'C', name: 'plate!' },
    ];
    const a = assignSlugs(items, 'part');
    const b = assignSlugs([...items].reverse(), 'part');
    expect(a.get('A')).toBe('plate');
    expect(a.get('B')).toBe('plate-2');
    expect(a.get('C')).toBe('plate-3');
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it('adding a same-named newer object never renames the existing one', () => {
    const before = assignSlugs([{ id: '01A', name: 'Gear' }], 'part');
    const after = assignSlugs(
      [
        { id: '01A', name: 'Gear' },
        { id: '01B', name: 'Gear' },
      ],
      'part',
    );
    expect(after.get('01A')).toBe(before.get('01A'));
  });
});

describe('project folder', () => {
  const doc = sampleDoc();
  const files = toFiles(doc);

  it('follows the PLAN §8A.1 layout', () => {
    expect([...files.keys()]).toEqual([
      MANIFEST_FILE,
      PARAMS_FILE,
      'parts/bracket.part.json',
      'parts/bracket-2.part.json',
      'drawings/sheet-1.drawing.json',
      'assemblies/asm.assembly.json',
    ]);
    const manifest = JSON.parse(text(files, MANIFEST_FILE));
    expect(manifest).toMatchObject({
      format: 'wren-project',
      schemaVersion: SCHEMA_VERSION,
      units: { length: 'mm', angle: 'deg' },
      meta: { name: 'Bracket', app: 'wren/test' },
    });
    // Keyed by id; order is document order.
    expect(manifest.parts).toEqual([
      { id: id(3), name: 'Bracket', file: 'parts/bracket.part.json' },
      { id: id(4), name: 'Bracket', file: 'parts/bracket-2.part.json' },
    ]);
    expect(JSON.parse(text(files, PARAMS_FILE)).params).toHaveLength(2);
    expect(JSON.parse(text(files, 'parts/bracket.part.json')).id).toBe(id(3));
  });

  it('every file is canonical text', () => {
    for (const [path, bytes] of files) {
      const t = strFromU8(bytes);
      expect(t.endsWith('\n'), path).toBe(true);
      expect(t, path).not.toContain('\r');
      expect(canonicalJson(JSON.parse(t)), path).toBe(t);
    }
  });

  it('round-trips the document exactly', () => {
    expect(fromFiles(files)).toEqual(doc);
  });

  it('M3.5 curves round-trip exactly: splines (weights, knots, through), elliptic arcs, minor-axis radius', () => {
    const curved = structuredClone(doc);
    const part = curved.parts[0];
    if (!part) throw new Error('no part');
    const pt = (n: number, x: number, y: number) => ({
      id: id(900 + n),
      kind: 'point' as const,
      x,
      y,
      construction: false,
    });
    part.features.push({
      id: id(950),
      type: 'sketch',
      name: 'Curves',
      suppressed: false,
      on: { name: 'origin:XY', kind: 'face' },
      entities: [
        pt(1, 0, 0),
        pt(2, 10, 0),
        pt(3, 0, 4),
        pt(4, -6, 8),
        pt(5, -9, -3),
        pt(6, -4.5, 1.25),
        {
          id: id(960),
          kind: 'ellipticArc',
          center: id(901),
          start: id(902),
          end: id(903),
          majorRadius: 10,
          minorRadius: 4,
          rotation: 0.25,
          construction: false,
        },
        {
          id: id(961),
          kind: 'bspline',
          poles: [id(903), id(904), id(905), id(902)],
          degree: 3,
          periodic: false,
          weights: [1, 1.5, 0.75, 1],
          knots: [0, 1],
          multiplicities: [4, 4],
          through: [id(906)],
          construction: false,
        },
      ],
      constraints: [
        {
          id: id(970),
          kind: 'radius',
          curve: id(960),
          axis: 'minor',
          value: '4 mm',
          driving: true,
        },
      ],
    });
    const f1 = toFiles(curved);
    const back = fromFiles(f1);
    expect(back).toEqual(curved);
    const f2 = toFiles(back);
    for (const [k, v] of f1) expect(f2.get(k), k).toEqual(v);
  });

  it('is byte-identical for equal documents (even deep clones)', () => {
    const again = toFiles(structuredClone(doc));
    expect([...again.keys()]).toEqual([...files.keys()]);
    for (const [k, v] of files) expect(again.get(k)).toEqual(v);
  });

  it('reordering parts keeps file contents and only changes the manifest order', () => {
    const swapped = { ...doc, parts: [...doc.parts].reverse() };
    const f2 = toFiles(swapped);
    expect(f2.get('parts/bracket.part.json')).toEqual(files.get('parts/bracket.part.json'));
    expect(f2.get('parts/bracket-2.part.json')).toEqual(files.get('parts/bracket-2.part.json'));
    expect(fromFiles(f2)).toEqual(swapped);
  });

  it('an empty document round-trips', () => {
    const d = newDoc({ now: '2026-01-01T00:00:00.000Z' });
    expect(fromFiles(toFiles(d))).toEqual(d);
  });

  it('ignores extra files (previews, releases, history)', () => {
    const f = new Map(files);
    f.set('previews/bracket.stl', strToU8('solid'));
    f.set('releases/rev-A/bracket.step', strToU8('ISO'));
    expect(fromFiles(f)).toEqual(doc);
  });

  it('gives clear errors for broken projects', () => {
    const missing = new Map(files);
    missing.delete('parts/bracket.part.json');
    expect(() => fromFiles(missing)).toThrow(/missing ‘parts\/bracket.part.json’/);
    expect(() => fromFiles(new Map())).toThrow(/missing ‘wren.project.json’/);
    const notJson = new Map(files);
    notJson.set(PARAMS_FILE, strToU8('{nope'));
    expect(() => fromFiles(notJson)).toThrow(ProjectFormatError);
    const wrongFormat = new Map(files);
    wrongFormat.set(MANIFEST_FILE, strToU8('{"format":"other"}'));
    expect(() => fromFiles(wrongFormat)).toThrow(/not a Wren project manifest/);
    const mismatch = new Map(files);
    const m = JSON.parse(text(files, MANIFEST_FILE));
    m.parts[0].id = 'someone-else';
    mismatch.set(MANIFEST_FILE, strToU8(JSON.stringify(m)));
    expect(() => fromFiles(mismatch)).toThrow(/manifest says someone-else/);
    const evil = new Map(files);
    const e = JSON.parse(text(files, MANIFEST_FILE));
    e.parts[0].file = '../../etc/passwd';
    evil.set(MANIFEST_FILE, strToU8(JSON.stringify(e)));
    expect(() => fromFiles(evil)).toThrow(/Invalid file path/);
  });

  it('migrates old and rejects newer documents', () => {
    const old = new Map(files);
    const m = JSON.parse(text(files, MANIFEST_FILE));
    m.schemaVersion = 0;
    m.assemblies = undefined;
    m.drawings = undefined;
    old.set(MANIFEST_FILE, strToU8(JSON.stringify(m)));
    const d = fromFiles(old);
    expect(d.schemaVersion).toBe(SCHEMA_VERSION);
    expect(d.drawings).toEqual([]);
    const future = new Map(files);
    m.schemaVersion = 99;
    future.set(MANIFEST_FILE, strToU8(JSON.stringify(m)));
    expect(() => fromFiles(future)).toThrow(/understands up to version 3/);
  });
});

describe('.wrencad archive', () => {
  const doc = sampleDoc();

  it('round-trips through zip, with and without cache', () => {
    const bytes = projectCodec.toWren(doc);
    const back = projectCodec.fromWren(bytes);
    expect(back.doc).toEqual(doc);
    expect(back.cache.size).toBe(0);

    const cache: ProjectFiles = new Map([
      ['meshes/F1.bin', new Uint8Array([1, 2, 3, 4])],
      ['thumb.png', new Uint8Array([9])],
    ]);
    const withCache = projectCodec.fromWren(projectCodec.toWren(doc, cache));
    expect(withCache.doc).toEqual(doc);
    expect([...withCache.cache.keys()].sort()).toEqual(['meshes/F1.bin', 'thumb.png']);
    expect(withCache.cache.get('meshes/F1.bin')).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('is deterministic: same document, same bytes, whatever the clock', () => {
    const a = projectCodec.toWren(doc);
    const b = projectCodec.toWren(structuredClone(doc));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const shuffled = shuffleKeys(doc, lcg(7)) as WrenDoc;
    expect(Buffer.from(projectCodec.toWren(shuffled)).equals(Buffer.from(a))).toBe(true);
  });

  it('is deterministic across time zones', () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      const tokyo = projectCodec.toWren(doc);
      process.env.TZ = 'America/Los_Angeles';
      const la = projectCodec.toWren(doc);
      expect(Buffer.from(tokyo).equals(Buffer.from(la))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('entries are sorted and carry the fixed 1980 timestamp', () => {
    const { files } = unpackFiles(projectCodec.toWren(doc));
    expect([...files.keys()]).toEqual([...files.keys()].sort());
    const zipped = projectCodec.toWren(doc);
    const dv = new DataView(zipped.buffer, zipped.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint16(10, true)).toBe(0);
    expect(dv.getUint16(12, true)).toBe(33);
  });

  it('is actually compressed and small', () => {
    const raw = [...toFiles(doc).values()].reduce((n, b) => n + b.length, 0);
    expect(projectCodec.toWren(doc).length).toBeLessThan(raw);
  });

  it('reads a project folder zipped by an ordinary tool (single wrapping directory)', () => {
    const wrapped: Record<string, Uint8Array> = {};
    for (const [k, v] of toFiles(doc)) wrapped[`my-bracket/${k}`] = v;
    expect(projectCodec.fromWren(zipSync(wrapped)).doc).toEqual(doc);
  });

  it('keeps extra project files (previews, releases) when using pack/unpack directly', () => {
    const f = toFiles(doc);
    f.set('previews/bracket.stl', strToU8('solid x'));
    const { files } = unpackFiles(packFiles(f));
    expect(strFromU8(files.get('previews/bracket.stl') as Uint8Array)).toBe('solid x');
  });

  it('rejects garbage, unsafe paths and oversize archives', () => {
    expect(() => projectCodec.fromWren(new Uint8Array([1, 2, 3]))).toThrow(/not a valid .wren/);
    const unsafe = zipSync({ '../evil.json': strToU8('{}') });
    expect(() => unpackFiles(unsafe)).toThrow(/unsafe path/);
    const noManifest = zipSync({ 'readme.txt': strToU8('hi') });
    expect(() => projectCodec.fromWren(noManifest)).toThrow(/missing ‘wren.project.json’/);
  });

  it('large documents round-trip (1000 features)', () => {
    const d = newDoc({ now: '2026-01-01T00:00:00.000Z' });
    d.parts = [
      {
        id: id(1),
        name: 'Big',
        features: Array.from({ length: 1000 }, (_, i) => box(10 + i)),
        rollbackIndex: 1000,
      },
    ];
    expect(projectCodec.fromWren(projectCodec.toWren(d)).doc).toEqual(d);
  });
});
