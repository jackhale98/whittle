/**
 * Regen golden 9 (M1 acceptance, engine level): `ImportFeature`. STEP export of the bracket →
 * import as a new part → same volume (1e-6); placement frames; attachment caching and integrity;
 * persistent names of imported topology (`F<id>:face#k`, edges/vertices from adjacent faces) that
 * stay stable across regens and survive downstream features; replacing the file with a scaled
 * or unrelated one resolves refs by fingerprint or reports them — never a wrong pick; multi-solid
 * files; mesh reference bodies.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  BodyResult,
  EntityRef,
  Feature,
  Frame,
  ImportFeature,
  RegenRequest,
  Vec3,
} from '@wren-cad/contracts';
import { analyzeStl, meshExporters } from '@wren-cad/io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/regen/imports';
import { BRACKET_DIMS, BRACKET_PARAMS, bracketDoc, bracketVolume } from './bracket';
import {
  type Api,
  built,
  describeFailures,
  edge,
  extrude,
  fid,
  fillet,
  loadApi,
  makeDoc,
  region,
  relClose,
  Sk,
  skipNote,
  states,
  totalVolume,
} from './helpers';

const SRC = fid('ISRC');
const PART = fid('IPRT');
const IMP = fid('IMP');
const FIL = fid('IFIL');
const SK = fid('ISK');
const CUT = fid('ICUT');

interface Attachment {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

function importFeature(
  a: Attachment,
  format: ImportFeature['source']['format'],
  extra: Partial<ImportFeature> = {},
): ImportFeature {
  return {
    id: IMP,
    type: 'import',
    name: 'Import',
    suppressed: false,
    source: { path: a.path, format, sha256: a.sha256, fileName: a.path.split('/').pop() ?? '' },
    op: 'new',
    ...extra,
  };
}

const near = (a: Vec3, b: Vec3, tol: number) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;

describe.skipIf(!built)(`regen golden: import${skipNote}`, () => {
  let api: Api;
  let step: Attachment;
  let scaled: Attachment;
  let boxStep: Attachment;
  let twoBoxes: Attachment;
  const volume = bracketVolume(BRACKET_DIMS);

  /** Exports a document's part as `format`, as an attachment at `path`. */
  async function attachmentOf(
    doc: ReturnType<typeof makeDoc>,
    path: string,
    format: 'step' | 'stl' = 'step',
  ): Promise<Attachment> {
    const partId = doc.parts[0]?.id as string;
    const r = await api.regenerate({ doc, partId: partId, quality: 'coarse' });
    expect(states(r), describeFailures(r)).toEqual(r.features.map(() => 'ok'));
    const out = await api.exportPart(partId, format);
    if (!out.ok) throw new Error(JSON.stringify(out.error));
    await api.closePart(partId);
    return { path, bytes: out.bytes, sha256: await sha256Hex(out.bytes) };
  }

  function boxDoc(id: string, boxes: [number, number, number, number][]) {
    return makeDoc(
      {},
      boxes.map(
        ([x, dx, dy, dz], i): Feature => ({
          id: fid(`${id}${i}`),
          type: 'primitive',
          name: 'Box',
          suppressed: false,
          op: 'new',
          shape: 'box',
          dx: `${dx}`,
          dy: `${dy}`,
          dz: `${dz}`,
          frame: { origin: [x, 0, 0], z: [0, 0, 1], x: [1, 0, 0] },
        }),
      ),
      SRC,
    );
  }

  beforeAll(async () => {
    api = await loadApi();
    step = await attachmentOf(bracketDoc(), 'imports/bracket.step');
    const big = bracketDoc();
    big.parts[0] = { ...(big.parts[0] as (typeof big.parts)[0]), id: SRC };
    for (const p of big.params) {
      const v = Number.parseFloat(BRACKET_PARAMS[p.name as keyof typeof BRACKET_PARAMS]);
      p.expr = `${v * 1.01} mm`;
    }
    scaled = await attachmentOf(big, 'imports/bracket-v2.step');
    boxStep = await attachmentOf(boxDoc('BX', [[0, 100, 60, 10]]), 'imports/box.step');
    twoBoxes = await attachmentOf(
      boxDoc('TB', [
        [30, 10, 10, 10],
        [0, 10, 10, 5],
      ]),
      'imports/two.step',
    );
  }, 120_000);
  afterAll(async () => {
    await api?.closePart(PART);
  });

  const regen = (features: Feature[], attachments: Attachment[] = []) => {
    const request: RegenRequest = {
      doc: makeDoc({}, features, PART),
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    };
    if (attachments.length > 0) {
      request.attachments = Object.fromEntries(attachments.map((a) => [a.path, a.bytes]));
    }
    return api.regenerate(request);
  };

  it('STEP export of the bracket imports as a new part with the same volume (1e-6)', async () => {
    const r = await regen([importFeature(step, 'step')], [step]);
    expect(states(r), describeFailures(r)).toEqual(['ok']);
    expect(r.bodies.map((b) => b.id)).toEqual([`B${IMP}`]);
    const body = r.bodies[0] as BodyResult;
    relClose(body.massProperties?.volume ?? 0, volume, 1e-6);
    // Every face is F<id>:face#k, ordered by the geometric key of its centroid.
    const names = body.mesh.faceNames;
    expect(names.every((n) => /^F[0-9A-Z]+:face#\d+$/.test(n))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    const fp = await api.fingerprints(body.shape);
    if (!fp.ok) throw new Error('fingerprints');
    const byIndex = names
      .map((n, i) => ({ k: Number(n.split('#')[1]), c: fp.value.faces[i]?.centroid as Vec3 }))
      .sort((a, b) => a.k - b.k);
    for (let i = 1; i < byIndex.length; i++) {
      const a = (byIndex[i - 1] as { c: Vec3 }).c.map((v) => Math.round(v * 1e6));
      const b = (byIndex[i] as { c: Vec3 }).c.map((v) => Math.round(v * 1e6));
      const cmp =
        (a[0] as number) - (b[0] as number) ||
        (a[1] as number) - (b[1] as number) ||
        (a[2] as number) - (b[2] as number);
      expect(cmp).toBeLessThan(0);
    }
    // Edges are named from their two adjacent faces.
    expect(
      body.mesh.edgeNames.every((n) =>
        new RegExp(`^edge\\(F${IMP}:face#\\d+(\\|F${IMP}:face#\\d+)?\\)(#\\d+)?$`).test(n),
      ),
    ).toBe(true);

    // Later regens need no attachment: the import is cached by sha256.
    const again = await regen([importFeature(step, 'step')]);
    expect(states(again)).toEqual(['ok']);
    expect(again.cache).toEqual({ hits: 1, misses: 0 });
    // A placement change re-runs the feature from the cached shape, still without attachments.
    const moved = await regen([
      importFeature(step, 'step', {
        frame: { origin: [100, 0, 0], z: [0, 0, 1], x: [0, 1, 0] },
      }),
    ]);
    expect(states(moved), describeFailures(moved)).toEqual(['ok']);
    expect(moved.cache.misses).toBe(1);
  });

  it('placement frame: rotated and moved, same volume and names', async () => {
    const frame: Frame = { origin: [100, 20, 5], z: [0, 0, 1], x: [0, 1, 0] };
    const plain = await regen([importFeature(step, 'step')], [step]);
    const r = await regen([importFeature(step, 'step', { frame })], [step]);
    expect(states(r), describeFailures(r)).toEqual(['ok']);
    const mp = r.bodies[0]?.massProperties;
    relClose(mp?.volume ?? 0, volume, 1e-6);
    // x → +Y, y → −X: the 80 × 50 × 48 bracket spans x 50…100, y 20…100, z 5…53.
    const bb = mp?.bbox;
    expect(bb?.min[0]).toBeCloseTo(50, 6);
    expect(bb?.max[0]).toBeCloseTo(100, 6);
    expect(bb?.min[1]).toBeCloseTo(20, 6);
    expect(bb?.max[1]).toBeCloseTo(100, 6);
    expect(bb?.min[2]).toBeCloseTo(5, 6);
    expect(bb?.max[2]).toBeCloseTo(53, 6);
    expect(r.bodies[0]?.mesh.faceNames.length).toBe(plain.bodies[0]?.mesh.faceNames.length);
    const bad = await regen([
      importFeature(step, 'step', { frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [0, 0, 2] } }),
    ]);
    expect(bad.features[0]?.state).toBe('error');
    expect(bad.features[0]?.error?.message).toMatch(/placement/);
  });

  it('missing or corrupted attachments are errors; IGES and mesh booleans are refused clearly', async () => {
    await api.closePart(PART); // forget the cached import
    const missing = await regen([importFeature(step, 'step')]);
    expect(missing.features[0]?.state).toBe('error');
    expect(missing.features[0]?.error?.message).toBe(
      'The imported file is missing from this project',
    );
    const corrupt = await regen(
      [importFeature(step, 'step')],
      [{ ...step, bytes: step.bytes.slice(0, step.bytes.length - 10) }],
    );
    expect(corrupt.features[0]?.state).toBe('error');
    expect(corrupt.features[0]?.error?.message).toMatch(/checksum/);
    const iges = await regen([importFeature(step, 'iges')], [step]);
    expect(iges.features[0]?.error?.code).toBe('UNSUPPORTED_FEATURE');
    expect(iges.features[0]?.error?.hint).toMatch(/STEP/);
    const meshAdd = await regen([importFeature(step, 'stl', { op: 'add' })], [step]);
    expect(meshAdd.features[0]?.error?.message).toMatch(/new reference body/);
  });

  /** Refs picked on the imported bracket: the upright's top back edge and its top face. */
  async function downstream(): Promise<{ edgeRef: EntityRef; faceRef: EntityRef }> {
    const r = await regen([importFeature(step, 'step')], [step]);
    const body = r.bodies[0] as BodyResult;
    const fp = await api.fingerprints(body.shape);
    if (!fp.ok) throw new Error('fingerprints');
    const ei = fp.value.edges.findIndex(
      (e) => near(e.centroid, [40, 50, 48], 1e-6) && Math.abs(e.length - 80) < 1e-6,
    );
    const fi = fp.value.faces.findIndex(
      (f) => f.normal?.[2] === 1 && Math.abs(f.centroid[2] - 48) < 1e-6,
    );
    expect(ei).toBeGreaterThanOrEqual(0);
    expect(fi).toBeGreaterThanOrEqual(0);
    const edgeRef = await api.refFor(PART, { bodyId: body.id, kind: 'edge', index: ei });
    const faceRef = await api.refFor(PART, { bodyId: body.id, kind: 'face', index: fi });
    if (!edgeRef || !faceRef) throw new Error('refFor');
    return { edgeRef, faceRef };
  }

  function modelOn(a: Attachment, refs: { edgeRef: EntityRef; faceRef: EntityRef }): Feature[] {
    const s = new Sk();
    s.circle('C', 40, 46, 1.5);
    s.geo({ kind: 'fix', entity: 'Cc' });
    return [
      importFeature(a, 'step'),
      fillet(FIL, [refs.edgeRef], '2'),
      s.feature(SK, refs.faceRef, 'Hole'),
      extrude(CUT, [region(SK, 'C')], '5', 'cut', 'reverse'),
    ];
  }

  const PI = Math.PI;
  // Fillet r 2 along the 80 × k edge; a ⌀3 hole 5 deep.
  const modelVolume = (k: number) => volume * k ** 3 - (1 - PI / 4) * 4 * 80 * k - PI * 2.25 * 5;

  it('fillet an imported edge, sketch on an imported face: names stable across regens', async () => {
    const refs = await downstream();
    expect(refs.edgeRef.name).toMatch(
      new RegExp(`^edge\\(F${IMP}:face#\\d+\\|F${IMP}:face#\\d+\\)$`),
    );
    expect(refs.faceRef.name).toMatch(new RegExp(`^F${IMP}:face#\\d+$`));
    const features = modelOn(step, refs);
    const a = await regen(features, [step]);
    expect(states(a), describeFailures(a)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(a.features[1]?.rebound).toBeUndefined();
    // The fillet shrank the face the sketch sits on: same name, but its stored fingerprint is out
    // of date, so it is reported for healing (name unchanged, current fingerprint).
    expect(a.features[2]?.rebound?.map((x) => [x.path, x.name, x.fingerprint?.area])).toEqual([
      ['/on', refs.faceRef.name, expect.closeTo(320, 6)],
    ]);
    relClose(totalVolume(a.bodies), modelVolume(1), 1e-7);
    const body = a.bodies[0] as BodyResult;
    const filletFaces = body.mesh.faceNames.filter((n) => n.startsWith(`F${FIL}:fillet(`));
    expect(filletFaces).toEqual([`F${FIL}:fillet(${refs.edgeRef.name})`]);
    // The surviving imported faces keep their names through the fillet and the cut.
    expect(body.mesh.faceNames).toContain(refs.faceRef.name);

    const b = await regen(features); // cached, no attachment
    expect(b.cache).toEqual({ hits: 4, misses: 0 });
    await api.closePart(PART);
    const c = await regen(features, [step]); // from scratch
    expect(c.cache.hits).toBe(0);
    const fresh = await loadApi();
    try {
      const d = await fresh.regenerate({
        doc: makeDoc({}, features, PART),
        partId: PART,
        quality: 'coarse',
        attachments: { [step.path]: step.bytes },
      });
      for (const r of [b, c, d]) {
        expect(states(r)).toEqual(['ok', 'ok', 'ok', 'ok']);
        expect(r.bodies[0]?.mesh.faceNames).toEqual(body.mesh.faceNames);
        expect(r.bodies[0]?.mesh.edgeNames).toEqual(body.mesh.edgeNames);
      }
      await fresh.closePart(PART);
    } finally {
      expect(fresh.liveHandleCount()).toBe(0);
    }
  });

  it('replacing the file with a scaled one: refs follow by fingerprint and report rebinding', async () => {
    const refs = await downstream();
    const r = await regen(modelOn(scaled, refs), [scaled]);
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok']);
    relClose(totalVolume(r.bodies), modelVolume(1.01), 1e-6);
    const body = r.bodies[0] as BodyResult;
    // The fillet sits on the scaled top back edge (1.01 × [40, 50, 48]) …
    const fi = body.mesh.faceNames.findIndex((n) => n.startsWith(`F${FIL}:fillet(`));
    const fp = await api.fingerprints(body.shape);
    if (!fp.ok) throw new Error('fingerprints');
    const fc = fp.value.faces[fi]?.centroid as Vec3;
    expect(fc[0]).toBeCloseTo(40.4, 6);
    expect(fc[1]).toBeGreaterThan(49);
    expect(fc[2]).toBeGreaterThan(47.5);
    // … and the sketch on the scaled upright's top (z = 48.48).
    expect(r.sketches.find((s) => s.featureId === SK)?.frame.origin[2]).toBeCloseTo(48.48, 6);
    // Both refs resolved by fingerprint: reported with their current name and fingerprint.
    const fr = r.features[1]?.rebound?.[0];
    expect(fr?.path).toBe('/edges/0');
    expect(fr?.fingerprint?.length).toBeCloseTo(80.8, 6);
    const sr = r.features[2]?.rebound?.[0];
    expect(sr?.path).toBe('/on');
    expect(sr?.fingerprint?.centroid[2]).toBeCloseTo(48.48, 6);
    // Healing the stored refs with the reported names/fingerprints: exact again, nothing rebound.
    const healed = modelOn(scaled, {
      edgeRef: {
        name: fr?.name as string,
        kind: 'edge',
        ...(fr?.fingerprint ? { fingerprint: fr.fingerprint } : {}),
      },
      faceRef: {
        name: sr?.name as string,
        kind: 'face',
        ...(sr?.fingerprint ? { fingerprint: sr.fingerprint } : {}),
      },
    });
    const h = await regen(healed);
    expect(states(h)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(h.features.every((f) => f.rebound === undefined)).toBe(true);
  });

  it('replacing the file with an unrelated one: needs attention with the old fingerprint, never a guess', async () => {
    const refs = await downstream();
    const r = await regen(modelOn(boxStep, refs), [boxStep]);
    expect(states(r), describeFailures(r)).toEqual([
      'ok',
      'needsAttention',
      'needsAttention',
      'blocked',
    ]);
    const u = r.features[1]?.unresolved?.[0];
    expect(u?.path).toBe('/edges/0');
    expect(u?.ref.fingerprint).toEqual(refs.edgeRef.fingerprint);
    expect(r.features[2]?.unresolved?.[0]?.ref.fingerprint).toEqual(refs.faceRef.fingerprint);
    relClose(totalVolume(r.bodies), 100 * 60 * 10, 1e-9);

    // A ref stored without a fingerprint: the engine reports where it last resolved instead.
    const bare = {
      edgeRef: { name: refs.edgeRef.name, kind: 'edge' as const },
      faceRef: refs.faceRef,
    };
    const ok = await regen(modelOn(step, bare), [step]);
    expect(states(ok), describeFailures(ok)).toEqual(['ok', 'ok', 'ok', 'ok']);
    const gone = await regen(modelOn(boxStep, bare), [boxStep]);
    const g = gone.features[1];
    expect(g?.state).toBe('needsAttention');
    expect(g?.unresolved?.[0]?.ref).toEqual(bare.edgeRef);
    expect(g?.unresolved?.[0]?.lastKnown).toEqual({ centroid: [40, 50, 48], length: 80 });
  });

  it('a file with several solids gives one body per solid, B<id>#k by geometric key', async () => {
    const r = await regen([importFeature(twoBoxes, 'step')], [twoBoxes]);
    expect(states(r), describeFailures(r)).toEqual(['ok']);
    expect(r.bodies.map((b) => b.id)).toEqual([`B${IMP}#0`, `B${IMP}#1`]);
    relClose(r.bodies[0]?.massProperties?.volume ?? 0, 500, 1e-9);
    relClose(r.bodies[1]?.massProperties?.volume ?? 0, 1000, 1e-9);
    // A downstream boolean between them works on the persistent body ids.
    const fused = await regen(
      [
        importFeature(twoBoxes, 'step'),
        {
          id: fid('IBOOL'),
          type: 'boolean',
          name: 'Combine',
          suppressed: false,
          op: 'add',
          target: { name: `B${IMP}#0`, kind: 'body' },
          tools: [{ name: `B${IMP}#1`, kind: 'body' }],
          keepTools: false,
        },
      ],
      [twoBoxes],
    );
    expect(states(fused), describeFailures(fused)).toEqual(['ok', 'ok']);
    expect(fused.bodies.map((b) => b.id)).toEqual([`B${IMP}#0`]);
  });

  it('op cut / add with the imported solid as the tool', async () => {
    const plate = new Sk();
    plate.rect('p', 'L', -10, -10, 90, 60);
    for (const id of ['pa', 'pb', 'pc', 'pd']) plate.geo({ kind: 'fix', entity: id });
    const PS = fid('IPS');
    const PE = fid('IPE');
    const base: Feature[] = [plate.feature(PS), extrude(PE, [region(PS, 'L1,L2,L3,L4')], '4')];
    const cut = await regen([...base, importFeature(step, 'step', { op: 'cut' })], [step]);
    expect(states(cut), describeFailures(cut)).toEqual(['ok', 'ok', 'ok']);
    expect(cut.bodies.map((b) => b.id)).toEqual([`B${PE}`]);
    // The bracket's base plate (z 0…8, minus holes and corner rounds) overlaps the plate's 4 mm.
    const k = 1 - PI / 4;
    const overlap = 80 * 50 * 4 - 2 * PI * 9 * 4 - 2 * k * 25 * 4;
    relClose(totalVolume(cut.bodies), 100 * 70 * 4 - overlap, 1e-7);
    const tool = cut.bodies[0]?.mesh.faceNames.filter((n) => n.startsWith(`F${IMP}:face(`)) ?? [];
    expect(tool.length).toBeGreaterThan(0);
    expect(
      tool.every((n) => new RegExp(`^F${IMP}:face\\(F${IMP}:face#\\d+\\)(#\\d+)?$`).test(n)),
    ).toBe(true);
    const add = await regen([...base, importFeature(step, 'step', { op: 'add' })], [step]);
    expect(states(add), describeFailures(add)).toEqual(['ok', 'ok', 'ok']);
    relClose(totalVolume(add.bodies), 100 * 70 * 4 + volume - overlap, 1e-7);
  });

  it('mesh files become mesh-only reference bodies: shown and exported, never modified', async () => {
    const stl = await attachmentOf(bracketDoc(), 'imports/bracket.stl', 'stl');
    const r0 = await regen([importFeature(stl, 'stl')], [stl]);
    expect(states(r0), describeFailures(r0)).toEqual(['ok']);
    const body = r0.bodies[0] as BodyResult;
    expect(body.mesh.faceNames).toEqual([`F${IMP}:face`]);
    // Mass properties come from the triangles (coarse STL export: within 1 %).
    relClose(body.massProperties?.volume ?? 0, volume, 1e-2);
    expect(body.mesh.indices.length).toBeGreaterThan(0);
    // 3MF of the same mesh, placed 100 mm along X.
    const tmf = meshExporters.to3mf([{ name: 'bracket', mesh: body.mesh }], 'millimeter');
    const tmfA: Attachment = { path: 'imports/b.3mf', bytes: tmf, sha256: await sha256Hex(tmf) };
    const frame: Frame = { origin: [100, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };
    const both = await regen(
      [importFeature(stl, 'stl'), { ...importFeature(tmfA, '3mf', { frame }), id: fid('IMP2') }],
      [stl, tmfA],
    );
    expect(states(both), describeFailures(both)).toEqual(['ok', 'ok']);
    expect(both.bodies[1]?.mesh.bbox.min[0]).toBeCloseTo(100, 3);
    const out = await api.exportPart(PART, 'stl', { bodies: [`B${fid('IMP2')}`] });
    if (!out.ok) throw new Error(JSON.stringify(out.error));
    relClose(analyzeStl(out.bytes).volume, volume, 5e-3);

    // Booleans, explicit scopes and fillets on a mesh body are refused clearly…
    const bool = await regen(
      [
        importFeature(stl, 'stl'),
        { ...importFeature(tmfA, '3mf', { frame }), id: fid('IMP2') },
        {
          id: fid('IBOOL'),
          type: 'boolean',
          name: 'Combine',
          suppressed: false,
          op: 'add',
          target: { name: `B${IMP}`, kind: 'body' },
          tools: [{ name: `B${fid('IMP2')}`, kind: 'body' }],
          keepTools: false,
        },
      ],
      [stl, tmfA],
    );
    expect(bool.features[2]?.state).toBe('error');
    expect(bool.features[2]?.error?.message).toBe('A mesh reference body cannot be combined');
    const s = new Sk();
    s.rect('p', 'L', 10, 10, 30, 30);
    for (const id of ['pa', 'pb', 'pc', 'pd']) s.geo({ kind: 'fix', entity: id });
    const XS = fid('IXS');
    const XC = fid('IXC');
    const scoped = await regen(
      [
        importFeature(stl, 'stl'),
        s.feature(XS),
        extrude(XC, [region(XS, 'L1,L2,L3,L4')], '100', 'cut', 'normal', {
          scope: { kind: 'bodies', bodies: [{ name: `B${IMP}`, kind: 'body' }] },
        }),
      ],
      [stl],
    );
    expect(scoped.features[2]?.error?.message).toBe('A mesh reference body cannot be changed');
    // … and an implicit scope never includes it: with no solid around there is nothing to cut.
    const implicit = await regen(
      [
        importFeature(stl, 'stl'),
        s.feature(XS),
        extrude(XC, [region(XS, 'L1,L2,L3,L4')], '100', 'cut'),
      ],
      [stl],
    );
    expect(states(implicit)).toEqual(['ok', 'ok', 'error']);
    expect(implicit.features[2]?.error?.message).toBe('There is no body to cut');
    expect(implicit.bodies.map((b) => b.id)).toEqual([`B${IMP}`]);
    const filletOnMesh = await regen(
      [importFeature(stl, 'stl'), fillet(FIL, [edge(`edge(F${IMP}:face)`)], '1')],
      [stl],
    );
    expect(filletOnMesh.features[1]?.state).not.toBe('ok');
  });

  it('closePart releases every imported shape (raw cache, placed copies, results)', async () => {
    const refs = await downstream();
    await regen(modelOn(step, refs), [step]);
    await regen(modelOn(scaled, refs), [scaled]);
    await regen(
      [
        importFeature(twoBoxes, 'step', {
          frame: { origin: [1, 2, 3], z: [0, 1, 0], x: [1, 0, 0] },
        }),
      ],
      [twoBoxes],
    );
    expect(api.liveHandleCount()).toBeGreaterThan(0);
    await api.closePart(PART);
    expect(api.liveHandleCount()).toBe(0);
  });
});
