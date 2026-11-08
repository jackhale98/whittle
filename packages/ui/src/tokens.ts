/**
 * Design tokens, mirrored for JS consumers (the viewport reads these for background, DOF colours,
 * selection accent, etc.). `styles/tokens.css` is the CSS source of truth for the DOM; the
 * `tokens.test.ts` suite asserts that both stay identical and that every text/UI pair meets
 * WCAG 2.2 AA contrast.
 */

export type ThemeName = 'light' | 'dark';

export interface ColorTokens {
  /** App chrome background (behind panels / around the viewport card). */
  bg: string;
  /** Opaque surface (panels, menus). Floating panels use this at `surfaceAlpha`. */
  surface: string;
  /** Inset / hover fill. */
  surface2: string;
  /** Pressed / selected fill. */
  surface3: string;
  /** Decorative hairlines. Not relied on to identify controls. */
  border: string;
  /** Control boundaries that must reach 3:1 (inputs, separators of interactive elements). */
  borderStrong: string;
  fg: string;
  fgMuted: string;
  /** Hints, placeholders, empty-state copy. Still >= 4.5:1. */
  fgSubtle: string;
  /** Selection + primary actions. Used as a fill, a focus ring and an icon colour. */
  accent: string;
  /** Text/icon colour on `accent` fills. */
  accentFg: string;
  accentSoft: string;
  /** Accent as text on `accentSoft` / `surface`. */
  accentText: string;
  /** Sketch geometry with free degrees of freedom. */
  underConstrained: string;
  /** Fully constrained sketch geometry: near-black on light, white on dark. */
  fullyConstrained: string;
  danger: string;
  dangerSoft: string;
  dangerText: string;
  warning: string;
  warningSoft: string;
  warningText: string;
  success: string;
  successSoft: string;
  successText: string;
  /** Viewport clear-colour gradient, top to bottom. */
  viewportTop: string;
  viewportBottom: string;
  /** Compare overlay: material the new version adds. Always paired with a + glyph. */
  compareAdded: string;
  compareAddedSoft: string;
  /** Compare overlay: material the new version removes. Always paired with a - glyph. */
  compareRemoved: string;
  compareRemovedSoft: string;
  /**
   * The exact fills the viewport draws for added and removed material (packages/viewport
   * `COMPARE_COLORS`, unit-tested for parity), for legend swatches. Non-text: >= 3:1 on surface.
   */
  compareAddedSwatch: string;
  compareRemovedSwatch: string;
}

export const colors: Record<ThemeName, ColorTokens> = {
  light: {
    bg: '#e9edf3',
    surface: '#ffffff',
    surface2: '#f3f5f9',
    surface3: '#e6eaf1',
    border: '#d9dfe9',
    borderStrong: '#76839a',
    fg: '#0f1729',
    fgMuted: '#46536b',
    fgSubtle: '#5a677f',
    accent: '#0b5fe8',
    accentFg: '#ffffff',
    accentSoft: '#e4eeff',
    accentText: '#0a54cc',
    underConstrained: '#2f6df6',
    fullyConstrained: '#111827',
    danger: '#d0281c',
    dangerSoft: '#fdecea',
    dangerText: '#b42318',
    warning: '#d97706',
    warningSoft: '#fff3d6',
    warningText: '#8a4b04',
    success: '#16a34a',
    successSoft: '#e1f5e8',
    successText: '#13693a',
    viewportTop: '#f7f9fc',
    viewportBottom: '#d9e0eb',
    compareAdded: '#0b6e4f',
    compareAddedSoft: '#dcf3ea',
    compareRemoved: '#b23c0a',
    compareRemovedSoft: '#fdebe1',
    compareAddedSwatch: '#00a878',
    compareRemovedSwatch: '#c2410c',
  },
  dark: {
    bg: '#0c0f16',
    surface: '#171b25',
    surface2: '#1f2430',
    surface3: '#2a3040',
    border: '#2b3243',
    borderStrong: '#6e7a93',
    fg: '#e8ecf4',
    fgMuted: '#a5b0c5',
    fgSubtle: '#8e9ab1',
    accent: '#5b9bff',
    accentFg: '#04132e',
    accentSoft: '#172a50',
    accentText: '#8dbbff',
    underConstrained: '#5b8dff',
    fullyConstrained: '#f4f6fb',
    danger: '#ff6b5e',
    dangerSoft: '#3a1a1c',
    dangerText: '#ff9a90',
    warning: '#f5a524',
    warningSoft: '#3a2d12',
    warningText: '#f7c066',
    success: '#3ecf72',
    successSoft: '#13301f',
    successText: '#6fdc95',
    viewportTop: '#1d2331',
    viewportBottom: '#0f131c',
    compareAdded: '#4fe0a8',
    compareAddedSoft: '#0f3328',
    compareRemoved: '#ff8a5a',
    compareRemovedSoft: '#3d2116',
    compareAddedSwatch: '#3ddc97',
    compareRemovedSwatch: '#ff6a2e',
  },
};

/** Alpha of floating (translucent) panels over the viewport. */
export const surfaceAlpha = 0.82;

export const radii = { control: 10, panel: 14, sheet: 20, pill: 999 } as const;

/** Stacking layers; mirrored by `--z-*` in tokens.css. */
export const layers = {
  viewport: 0,
  overlay: 10,
  panel: 20,
  sheet: 30,
  popover: 40,
  modal: 50,
} as const;

/** Minimum interactive target sizes in CSS px. */
export const targets = { pointer: 32, touch: 44 } as const;

export const fontFamily = "'Inter Variable', ui-sans-serif, system-ui, sans-serif";
