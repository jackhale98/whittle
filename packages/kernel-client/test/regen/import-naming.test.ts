/**
 * Persistent names of imported topology stay what documents already store. The golden
 * (fixtures/import-naming.golden.json) was recorded with the M1 engine (BREP location rewrite +
 * naming by a no-op intersect in the kernel, before ADR-044); the
 * kernel `import` feature must give every face, edge and vertex of the same geometry the same
 * name, and the same body ids, so references into imported bodies keep resolving by name.
 *
 * Re-record (only when the naming scheme changes on purpose, with a migration):
 * `WREN_UPDATE_IMPORT_GOLDEN=1 pnpm vitest run test/regen/import-naming.test.ts`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Feature, Frame, ImportFeature, RegenRequest, Vec3 } from '@wren-cad/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/regen/imports';
import {
  type Api,
  built,
  describeFailures,
  extrude,
  fid,
  loadApi,
  makeDoc,
  region,
  Sk,
  skipNote,
  states,
} from './helpers';

const GOLDEN = fileURLToPath(new URL('./fixtures/import-naming.golden.json', import.meta.url));
const BRACKET_STEP = fileURLToPath(new URL('./fixtures/bracket-m1.step', import.meta.url));
const UPDATE = process.env.WREN_UPDATE_IMPORT_GOLDEN === '1';

const PART = fid('INPRT');
const IMP = fid('INIMP');

interface Attachment {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

/** name → centroid (rounded to 1e-5 mm), per kind, per body id. */
type BodyNames = Record<'face' | 'edge' | 'vertex', Record<string, Vec3>>;
type Golden = Record<string, Record<string, BodyNames>>;

/** Keys sorted at every object level (stable diffs); arrays kept. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v) || v === null || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
  );
}

const round = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1e5) / 1e5 || 0) as Vec3;

function importFeature(a: Attachment, extra: Partial<ImportFeature> = {}): ImportFeature {
  return {
    id: IMP,
    type: 'import',
    name: 'Import',
    suppressed: false,
    source: { path: a.path, format: 'step', sha256: a.sha256, fileName: 'x.step' },
    op: 'new',
    ...extra,
  };
}

describe.skipIf(!built)(`imported names match the M1 engine's${skipNote}`, () => {
  let api: Api;
  let bracket: Attachment;
  let twoBoxes: Attachment;
  const recorded: Golden = {};
  const golden: Golden =
    !UPDATE && existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden) : {};

  async function attachmentOf(doc: ReturnType<typeof makeDoc>, path: string): Promise<Attachment> {
    const partId = doc.parts[0]?.id as string;
    const r = await api.regenerate({ doc, partId, quality: 'coarse' });
    expect(states(r), describeFailures(r)).toEqual(r.features.map(() => 'ok'));
    const out = await api.exportPart(partId, 'step');
    if (!out.ok) throw new Error(JSON.stringify(out.error));
    await api.closePart(partId);
    return { path, bytes: out.bytes, sha256: await sha256Hex(out.bytes) };
  }

  beforeAll(async () => {
    api = await loadApi();
    // Frozen: the M1 bracket as the engine built it before ADR-078 (17 faces, back and sides split
    // at the plate's top), so the golden keeps guarding import naming, not the bracket's modelling.
    const bytes = new Uint8Array(readFileSync(BRACKET_STEP));
    bracket = { path: 'imports/bracket.step', bytes, sha256: await sha256Hex(bytes) };
    const boxes = makeDoc(
      {},
      (
        [
          [30, 10, 10, 10],
          [0, 10, 10, 5],
          [30, 4, 4, 4],
        ] as const
      ).map(
        ([x, dx, dy, dz], i): Feature => ({
          id: fid(`INB${i}`),
          type: 'primitive',
          name: 'Box',
          suppressed: false,
          op: 'new',
          shape: 'box',
          dx: `${dx}`,
          dy: `${dy}`,
          dz: `${dz}`,
          frame: { origin: [x, i === 2 ? 20 : 0, 0], z: [0, 0, 1], x: [1, 0, 0] },
        }),
      ),
      fid('INSRC'),
    );
    twoBoxes = await attachmentOf(boxes, 'imports/boxes.step');
  }, 120_000);

  afterAll(async () => {
    await api?.closePart(PART);
    if (UPDATE) writeFileSync(GOLDEN, `${JSON.stringify(sorted(recorded), null, 2)}\n`);
  });

  async function namesOf(features: Feature[], attachments: Attachment[]) {
    const request: RegenRequest = {
      doc: makeDoc({}, features, PART),
      partId: PART,
      quality: 'coarse',
      attachments: Object.fromEntries(attachments.map((a) => [a.path, a.bytes])),
    };
    const r = await api.regenerate(request);
    expect(states(r), describeFailures(r)).toEqual(features.map(() => 'ok'));
    const out: Record<string, BodyNames> = {};
    for (const body of r.bodies) {
      const fp = await api.fingerprints(body.shape);
      if (!fp.ok) throw new Error('fingerprints');
      const names: BodyNames = { face: {}, edge: {}, vertex: {} };
      const lists = {
        face: fp.value.faces.map((f) => f.centroid),
        edge: fp.value.edges.map((e) => e.centroid),
        vertex: fp.value.vertices.map((v) => v.point),
      };
      for (const kind of ['face', 'edge', 'vertex'] as const) {
        for (let index = 0; index < lists[kind].length; index++) {
          const ref = await api.refFor(PART, { bodyId: body.id, kind, index });
          if (!ref) throw new Error(`${body.id} ${kind} ${index} has no name`);
          expect(names[kind][ref.name], `${ref.name} is unique`).toBeUndefined();
          names[kind][ref.name] = round(lists[kind][index] as Vec3);
        }
      }
      out[body.id] = names;
    }
    return out;
  }

  function check(name: string, actual: Record<string, BodyNames>) {
    recorded[name] = actual;
    if (UPDATE) return;
    const expected = golden[name];
    expect(expected, `golden case ${name} (record with WREN_UPDATE_IMPORT_GOLDEN=1)`).toBeDefined();
    expect(Object.keys(actual)).toEqual(Object.keys(expected ?? {}));
    for (const [id, body] of Object.entries(expected ?? {})) {
      for (const kind of ['face', 'edge', 'vertex'] as const) {
        const got = actual[id]?.[kind] ?? {};
        expect(Object.keys(got).sort(), `${name} ${id} ${kind} names`).toEqual(
          Object.keys(body[kind]).sort(),
        );
        for (const [n, c] of Object.entries(body[kind])) {
          const g = got[n] as Vec3;
          const d = Math.hypot(g[0] - c[0], g[1] - c[1], g[2] - c[2]);
          expect(d, `${name} ${id} ${n} sits where it did`).toBeLessThan(1e-4);
        }
      }
    }
  }

  const frames: Record<string, Frame> = {
    moved: { origin: [100, 20, 5], z: [0, 0, 1], x: [0, 1, 0] },
    tilted: { origin: [3, -7, 11], z: [1, 1, 1], x: [1, -1, 0] },
  };

  it('a STEP bracket, in place, moved and tilted', async () => {
    check('bracket', await namesOf([importFeature(bracket)], [bracket]));
    for (const [k, frame] of Object.entries(frames)) {
      check(`bracket-${k}`, await namesOf([importFeature(bracket, { frame })], [bracket]));
    }
  });

  it('a file with three solids: body ids and names per body', async () => {
    check('boxes', await namesOf([importFeature(twoBoxes)], [twoBoxes]));
    const frame: Frame = { origin: [1, 2, 3], z: [0, 1, 0], x: [1, 0, 0] };
    check('boxes-placed', await namesOf([importFeature(twoBoxes, { frame })], [twoBoxes]));
  });

  it('cut with the imported bracket: tool faces F<id>:face(F<id>:face#k)', async () => {
    const plate = new Sk();
    plate.rect('p', 'L', -10, -10, 90, 60);
    for (const id of ['pa', 'pb', 'pc', 'pd']) plate.geo({ kind: 'fix', entity: id });
    const PS = fid('INPS');
    const PE = fid('INPE');
    const base: Feature[] = [plate.feature(PS), extrude(PE, [region(PS, 'L1,L2,L3,L4')], '4')];
    check(
      'bracket-cut',
      await namesOf([...base, importFeature(bracket, { op: 'cut' })], [bracket]),
    );
    check(
      'bracket-add-moved',
      await namesOf(
        [
          ...base,
          importFeature(bracket, {
            op: 'add',
            frame: { origin: [10, 0, 2], z: [0, 0, 1], x: [1, 0, 0] },
          }),
        ],
        [bracket],
      ),
    );
  });
});
