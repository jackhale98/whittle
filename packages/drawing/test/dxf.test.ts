/**
 * DXF goldens and a structure audit written here (ezdxf-style checks: sections, handles, owners,
 * table references). The real ezdxf audit and LibreCAD's dxf2pdf conversion run when the tools
 * are installed (CI); they are skipped otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DisplayList } from '../src/annotation';
import { dxfNum, dxfText, lineweight, renderDxf, renderDxfR12, renderDxfR2000 } from '../src/dxf';
import { bracketBuild } from './fixtures';

const style = { lineGroup: 'iso-0.5' as const };

/** A small list with one of everything (the golden input). */
const BASIC: DisplayList = {
  width: 210,
  height: 297,
  items: [
    { kind: 'line', a: [10, 10], b: [100, 10], role: 'visible' },
    { kind: 'line', a: [10, 20], b: [100, 20], role: 'hidden' },
    { kind: 'arc', center: [50, 50], radius: 10, start: 0, end: Math.PI / 2, role: 'visible' },
    { kind: 'arc', center: [50, 80], radius: 5, start: 0, end: 2 * Math.PI, role: 'visible' },
    { kind: 'line', a: [40, 80], b: [60, 80], role: 'center' },
    {
      kind: 'polyline',
      points: [
        [120, 10],
        [150, 10],
        [150, 40],
      ],
      closed: true,
      role: 'thin',
    },
    {
      kind: 'ellipse',
      center: [150, 100],
      major: [20, 0],
      ratio: 0.5,
      start: 0,
      end: Math.PI,
      role: 'visible',
    },
    {
      kind: 'spline',
      degree: 3,
      poles: [
        [10, 150],
        [30, 170],
        [50, 130],
        [70, 150],
      ],
      knots: [0, 0, 0, 0, 1, 1, 1, 1],
      role: 'visible',
    },
    {
      kind: 'fill',
      loops: [
        [
          [100, 150],
          [103, 150.8],
          [103, 149.2],
        ],
      ],
      role: 'dimension',
    },
    {
      kind: 'text',
      at: [100, 200],
      text: 'Ø20 ±0.1 45°',
      height: 3.5,
      angle: 0,
      align: 'center',
      baseline: 'middle',
      role: 'text',
    },
    {
      kind: 'text',
      at: [20, 200],
      text: 'Rz 6,3 µm',
      height: 2.5,
      angle: 90,
      align: 'left',
      baseline: 'baseline',
      role: 'text',
    },
    { kind: 'line', a: [10, 250], b: [60, 250], role: 'dimension', attention: true },
    { kind: 'line', a: [10, 260], b: [15, 260], role: 'cuttingPlaneEnd' },
  ],
};

const GOLDEN = join(__dirname, 'golden');

function golden(name: string, actual: string): void {
  const f = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDENS || !existsSync(f)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(f, actual);
  }
  expect(actual).toBe(readFileSync(f, 'utf8'));
}

type Tag = [number, string];
function tags(dxf: string): Tag[] {
  const lines = dxf.split('\n');
  if (lines.at(-1) === '') lines.pop();
  expect(lines.length % 2).toBe(0);
  const out: Tag[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number((lines[i] ?? '').trim());
    expect(Number.isInteger(code), `group code at line ${i + 1}`).toBe(true);
    out.push([code, lines[i + 1] ?? '']);
  }
  return out;
}

/** Splits into `0`-started records. */
function records(t: Tag[]): Tag[][] {
  const out: Tag[][] = [];
  for (const tag of t) {
    if (tag[0] === 0) out.push([tag]);
    else out.at(-1)?.push(tag);
  }
  return out;
}

function sections(t: Tag[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < t.length - 1; i++)
    if (t[i]?.[1] === 'SECTION' && t[i + 1]?.[0] === 2) names.push(t[i + 1]?.[1] ?? '');
  return names;
}

const get = (r: Tag[], code: number) => r.find((x) => x[0] === code)?.[1];

function tableNames(recs: Tag[][], type: string): Set<string> {
  return new Set(recs.filter((r) => r[0]?.[1] === type).map((r) => get(r, 2) ?? ''));
}

/** The checks ezdxf's auditor makes that matter for LibreCAD/QCAD (references and structure). */
function audit(dxf: string, profile: 'r12' | 'r2000') {
  const t = tags(dxf);
  expect(t.at(-1)).toEqual([0, 'EOF']);
  const recs = records(t);
  const layers = tableNames(recs, 'LAYER');
  const ltypes = new Set([...tableNames(recs, 'LTYPE')].map((s) => s.toUpperCase()));
  const styles = tableNames(recs, 'STYLE');
  let inEntities = false;
  const entities: Tag[][] = [];
  for (const r of recs) {
    if (r[0]?.[1] === 'SECTION') inEntities = get(r, 2) === 'ENTITIES';
    else if (r[0]?.[1] === 'ENDSEC') inEntities = false;
    else if (inEntities) entities.push(r);
  }
  for (const e of entities) {
    expect(layers.has(get(e, 8) ?? ''), `layer of ${e[0]?.[1]}`).toBe(true);
    if (e[0]?.[1] === 'TEXT') expect(styles.has(get(e, 7) ?? '')).toBe(true);
  }
  for (const l of recs.filter((r) => r[0]?.[1] === 'LAYER'))
    expect(ltypes.has((get(l, 6) ?? '').toUpperCase())).toBe(true);
  // Table counts are at least the number of entries.
  for (const tab of recs.filter((r) => r[0]?.[1] === 'TABLE')) {
    const name = get(tab, 2) ?? '';
    const count = Number(get(tab, 70));
    const n = recs.filter((r) => r[0]?.[1] === name).length;
    expect(count, name).toBeGreaterThanOrEqual(n);
  }
  if (profile === 'r12') {
    expect(sections(t)).toEqual(['HEADER', 'TABLES', 'ENTITIES']);
    expect(t.some(([c]) => c === 5 || c === 330)).toBe(false);
    return { entities };
  }
  expect(sections(t)).toEqual(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']);
  const handles = new Set<string>();
  for (const r of recs) {
    if (r[0]?.[1] === 'SECTION') continue; // the HEADER's $HANDSEED is not a handle
    const h = r[0]?.[1] === 'DIMSTYLE' ? get(r, 105) : get(r, 5);
    if (!h) continue;
    expect(/^[0-9A-F]+$/.test(h), h).toBe(true);
    expect(handles.has(h), `duplicate handle ${h}`).toBe(false);
    handles.add(h);
  }
  // Every owner and pointer refers to an existing object.
  for (const [code, v] of t)
    if ((code === 330 || code === 340 || code === 350) && v !== '0')
      expect(handles.has(v), `${code} → ${v}`).toBe(true);
  const seed = Number.parseInt(
    t[t.findIndex(([c, v]) => c === 9 && v === '$HANDSEED') + 1]?.[1] ?? '0',
    16,
  );
  expect(seed).toBeGreaterThan(Math.max(...[...handles].map((h) => Number.parseInt(h, 16))));
  const header = (name: string) => t[t.findIndex(([c, v]) => c === 9 && v === name) + 1]?.[1];
  expect(header('$ACADVER')).toBe('AC1015');
  expect(header('$INSUNITS')).toBe('4');
  expect(header('$MEASUREMENT')).toBe('1');
  expect(header('$LTSCALE')).toBe('1.0');
  return { entities };
}

describe('DXF encoding', () => {
  it('writes fixed-point numbers and DXF text escapes', () => {
    expect(dxfNum(1)).toBe('1');
    expect(dxfNum(0.1 + 0.2)).toBe('0.3');
    expect(dxfNum(1e-9)).toBe('0.0');
    expect(dxfNum(-2.5)).toBe('-2.5');
    expect(dxfText('Ø20 ±0.1 45° µ')).toBe('%%c20 %%p0.1 45%%d \\U+00B5');
    expect(lineweight(0.5)).toBe(50);
    expect(lineweight(0.18)).toBe(18);
    expect(lineweight(0.7)).toBe(70);
  });
});

describe('DXF goldens', () => {
  it('R12 CNC-safe profile', () => {
    const dxf = renderDxfR12(BASIC, style);
    golden('basic-r12.dxf', dxf);
    const { entities } = audit(dxf, 'r12');
    const types = new Set(entities.map((e) => e[0]?.[1]));
    expect([...types].sort()).toEqual([
      'ARC',
      'CIRCLE',
      'LINE',
      'POLYLINE',
      'SEQEND',
      'TEXT',
      'VERTEX',
    ]);
  });
  it('R12 geometry-only leaves text out', () => {
    expect(renderDxfR12(BASIC, style, { geometryOnly: true })).not.toContain('  0\nTEXT\n');
  });
  it('R2000 with layers, line types, lineweights and $INSUNITS = 4', () => {
    const dxf = renderDxfR2000(BASIC, style);
    golden('basic-r2000.dxf', dxf);
    const { entities } = audit(dxf, 'r2000');
    const types = new Set(entities.map((e) => e[0]?.[1]));
    expect([...types].sort()).toEqual([
      'ARC',
      'CIRCLE',
      'ELLIPSE',
      'LINE',
      'LWPOLYLINE',
      'SOLID',
      'SPLINE',
      'TEXT',
    ]);
    const recs = records(tags(dxf));
    const visible = recs.find((r) => r[0]?.[1] === 'LAYER' && get(r, 2) === 'VISIBLE');
    expect(get(visible ?? [], 370)).toBe('50');
    const hidden = recs.find((r) => r[0]?.[1] === 'LAYER' && get(r, 2) === 'HIDDEN');
    expect(get(hidden ?? [], 6)).toBe('DASHED_ISO');
    const dashed = recs.find((r) => r[0]?.[1] === 'LTYPE' && get(r, 2) === 'DASHED_ISO') ?? [];
    expect(dashed.filter(([c]) => c === 49).map(([, v]) => Number(v))).toEqual([3, -0.75]);
    // The attention line is red; the cutting-plane end carries its thick lineweight.
    const attention = entities.find((e) => get(e, 62) === '1');
    expect(get(attention ?? [], 8)).toBe('DIMENSION');
    expect(entities.some((e) => get(e, 8) === 'CUTTING_PLANE' && get(e, 370) === '50')).toBe(true);
  });
  it('renderDxf picks the profile', () => {
    expect(renderDxf(BASIC, style, { profile: 'r12' })).toContain('AC1009');
    expect(renderDxf(BASIC, style, { profile: 'r2000' })).toContain('AC1015');
  });
});

describe('DXF of the bracket drawing (audit)', () => {
  const sheet = bracketBuild().sheets[0]!;
  it('passes the structure audit in both profiles', () => {
    audit(renderDxfR12(sheet.list, style), 'r12');
    audit(renderDxfR2000(sheet.list, style), 'r2000');
  });
  it('is deterministic', () => {
    expect(renderDxfR2000(sheet.list, style)).toBe(renderDxfR2000(sheet.list, style));
  });
});

function python(code: string): boolean {
  try {
    execFileSync('python3', ['-I', '-c', code], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_EZDXF = python('import ezdxf');

describe.skipIf(!HAS_EZDXF)('ezdxf audit (CI; skipped without python ezdxf)', () => {
  it('reads both profiles without audit errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wren-dxf-'));
    try {
      const sheet = bracketBuild().sheets[0]!;
      for (const [name, dxf] of [
        ['r12.dxf', renderDxfR12(sheet.list, style)],
        ['r2000.dxf', renderDxfR2000(sheet.list, style)],
      ] as const) {
        const f = join(dir, name);
        writeFileSync(f, dxf);
        const out = execFileSync(
          'python3',
          [
            '-I',
            '-c',
            'import sys, ezdxf\ndoc = ezdxf.readfile(sys.argv[1])\na = doc.audit()\nprint(len(a.errors))',
            f,
          ],
          { encoding: 'utf8' },
        );
        expect(out.trim(), name).toBe('0');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
