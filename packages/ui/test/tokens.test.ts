import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ColorTokens, colors, surfaceAlpha, type ThemeName } from '../src/tokens';

/* ------------------------------------------------------------------ colour maths (WCAG 2.x) */

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) throw new Error(`bad hex ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

type RGB = [number, number, number];

function over(fg: RGB, alpha: number, bg: RGB): RGB {
  const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])];
}

const c = (t: ColorTokens, k: keyof ColorTokens) => hexToRgb(t[k]);

/* ------------------------------------------------------------------ contrast */

type Pair = [fg: keyof ColorTokens, bg: keyof ColorTokens, min: number, why: string];

/** Text pairs: >= 4.5. UI-component boundaries / focus indicators / graphics: >= 3. */
const pairs: Pair[] = [
  // Body text on every surface it sits on.
  ['fg', 'surface', 4.5, 'primary text on panels'],
  ['fg', 'surface2', 4.5, 'primary text on inset fills'],
  ['fg', 'surface3', 4.5, 'primary text on pressed fills'],
  ['fg', 'bg', 4.5, 'primary text on chrome'],
  ['fgMuted', 'surface', 4.5, 'secondary text on panels'],
  ['fgMuted', 'surface2', 4.5, 'secondary text on inset fills'],
  ['fgMuted', 'surface3', 4.5, 'secondary text on pressed fills'],
  ['fgMuted', 'bg', 4.5, 'secondary text on chrome'],
  ['fgSubtle', 'surface', 4.5, 'hint text on panels'],
  ['fgSubtle', 'surface2', 4.5, 'hint text on inset fills'],
  ['fgSubtle', 'bg', 4.5, 'hint text on chrome'],
  // Actions.
  ['accentFg', 'accent', 4.5, 'text on primary button'],
  ['accentText', 'accentSoft', 4.5, 'accent text on soft accent fill'],
  ['accentText', 'surface', 4.5, 'accent text on panels'],
  ['accentText', 'bg', 4.5, 'accent text on chrome'],
  // Semantic text on its soft fill (status chip, banners) and on surfaces.
  ['dangerText', 'dangerSoft', 4.5, 'error chip text'],
  ['dangerText', 'surface', 4.5, 'error text on panels'],
  ['warningText', 'warningSoft', 4.5, 'warning chip text'],
  ['warningText', 'surface', 4.5, 'warning text on panels'],
  ['successText', 'successSoft', 4.5, 'success chip text'],
  ['successText', 'surface', 4.5, 'success text on panels'],
  // Non-text: focus ring, control boundaries, status dots (large / UI component = 3:1).
  ['accent', 'surface', 3, 'focus ring / selection on panels'],
  ['accent', 'bg', 3, 'focus ring on chrome'],
  ['accent', 'viewportBottom', 3, 'focus ring / selection over viewport'],
  ['accent', 'viewportTop', 3, 'focus ring / selection over viewport'],
  ['borderStrong', 'surface', 3, 'input boundary on panels'],
  ['borderStrong', 'bg', 3, 'input boundary on chrome'],
  ['danger', 'surface', 3, 'error graphic'],
  ['warning', 'surface', 2.5, 'warning dot (paired with text, informational only)'],
  ['success', 'surface', 3, 'success graphic'],
  ['underConstrained', 'viewportTop', 3, 'under-constrained geometry'],
  ['underConstrained', 'viewportBottom', 3, 'under-constrained geometry'],
  ['fullyConstrained', 'viewportTop', 3, 'fully-constrained geometry'],
  ['fullyConstrained', 'viewportBottom', 3, 'fully-constrained geometry'],
];

describe.each(['light', 'dark'] as ThemeName[])('WCAG 2.2 AA contrast (%s)', (theme) => {
  const t = colors[theme];
  it.each(pairs)('%s on %s >= %f (%s)', (fg, bg, min) => {
    expect(contrast(c(t, fg), c(t, bg))).toBeGreaterThanOrEqual(min);
  });

  it('translucent floating panel text stays >= 4.5:1 over the viewport extremes', () => {
    for (const vp of [t.viewportTop, t.viewportBottom, t.bg]) {
      const panel = over(hexToRgb(t.surface), surfaceAlpha, hexToRgb(vp));
      for (const k of ['fg', 'fgMuted', 'fgSubtle', 'accentText'] as const) {
        expect(contrast(c(t, k), panel), `${k} over ${vp}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

/* ------------------------------------------------------------------ CSS <-> TS parity */

const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

/** Extract the body of the first block whose header matches `header`, brace-matched. */
function block(header: string): string {
  const start = css.indexOf(header);
  if (start < 0) throw new Error(`no block ${header}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('unbalanced css');
}

const kebab = (s: string) => s.replace(/[A-Z]|\d+/g, (m) => `-${m.toLowerCase()}`);

function colorVars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)) {
    out[m[1] as string] = (m[2] as string).toLowerCase();
  }
  return out;
}

describe('tokens.css mirrors tokens.ts', () => {
  const expected = (theme: ThemeName) =>
    Object.fromEntries(Object.entries(colors[theme]).map(([k, v]) => [kebab(k), v.toLowerCase()]));

  it('light values live in @theme', () => {
    expect(colorVars(block('@theme static'))).toEqual(expected('light'));
  });
  it('dark values match under data-theme="dark"', () => {
    expect(colorVars(block(':root[data-theme="dark"]'))).toEqual(expected('dark'));
  });
  it('dark values match under prefers-color-scheme (no explicit theme)', () => {
    expect(colorVars(block('@media (prefers-color-scheme: dark)'))).toEqual(expected('dark'));
  });
});
