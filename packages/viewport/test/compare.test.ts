import type { CompareOverlay } from '@wren-cad/contracts';
import { boxMesh } from '@wren-cad/test-fixtures';
import type { Material, Mesh } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  buildCompareGroup,
  COMPARE_COLORS,
  compareBounds,
  DEFAULT_GHOST_OPACITY,
  effectiveOpacity,
  ghostOpacityOf,
  sameGeometry,
  sideVisibility,
} from '../src/compare';
import { disposeOverlay, sharedOverlayMaterialCount } from '../src/overlays';

const added = [boxMesh(10, 10, 10, { origin: [40, 0, 0] })];
const removed = [boxMesh(5, 5, 5, { origin: [-10, -10, 0] })];
const overlay: CompareOverlay = { added, removed };

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
};

describe('compare pure parts', () => {
  it('ghost opacity defaults to 0.15 and is clamped', () => {
    expect(ghostOpacityOf(overlay)).toBe(DEFAULT_GHOST_OPACITY);
    expect(ghostOpacityOf({ ...overlay, ghostOpacity: 2 })).toBe(1);
    expect(ghostOpacityOf({ ...overlay, ghostOpacity: -1 })).toBe(0);
    expect(ghostOpacityOf({ ...overlay, ghostOpacity: Number.NaN })).toBe(DEFAULT_GHOST_OPACITY);
  });

  it('ghosting never makes a body more opaque', () => {
    expect(effectiveOpacity(1, null)).toBe(1);
    expect(effectiveOpacity(1, 0.15)).toBe(0.15);
    expect(effectiveOpacity(0.1, 0.15)).toBe(0.1);
  });

  it('show selects sides', () => {
    expect(sideVisibility(undefined)).toEqual({ added: true, removed: true });
    expect(sideVisibility('added')).toEqual({ added: true, removed: false });
    expect(sideVisibility('removed')).toEqual({ added: false, removed: true });
  });

  it('bounds cover the visible sides only', () => {
    expect(compareBounds(overlay)).toEqual({ min: [-10, -10, 0], max: [50, 10, 10] });
    expect(compareBounds({ ...overlay, show: 'added' })).toEqual({
      min: [40, 0, 0],
      max: [50, 10, 10],
    });
    expect(compareBounds({ added: [], removed: [] })).toBeNull();
  });

  it('geometry identity ignores show and ghostOpacity', () => {
    expect(sameGeometry(overlay, { ...overlay, show: 'added', ghostOpacity: 0.5 })).toBe(true);
    expect(sameGeometry(overlay, { added: [...added], removed })).toBe(false);
  });

  it('colours differ strongly in luminance (colour-vision safe) in both themes', () => {
    for (const t of ['light', 'dark'] as const) {
      const c = COMPARE_COLORS[t];
      expect(Math.abs(lum(c.added) - lum(c.removed))).toBeGreaterThan(0.08);
    }
    const [a, r] = [COMPARE_COLORS.light.added, COMPARE_COLORS.light.removed];
    expect(Number.parseInt(a.slice(3, 5), 16)).toBeGreaterThan(Number.parseInt(a.slice(1, 3), 16));
    expect(Number.parseInt(r.slice(1, 3), 16)).toBeGreaterThan(Number.parseInt(r.slice(3, 5), 16));
  });
});

describe('compare objects', () => {
  const build = (o: CompareOverlay) => buildCompareGroup(o, COMPARE_COLORS.light, 1.8, 2);

  it('builds fill + edges per mesh and honours show', () => {
    const c = build({ ...overlay, show: 'removed' });
    expect(c.added.visible).toBe(false);
    expect(c.removed.visible).toBe(true);
    expect(c.added.children.length).toBe(2); // fill + edges
    disposeOverlay(c.root);
  });

  it('rebuilding and disposing reuses shared materials (no new shaders)', () => {
    const first = build(overlay);
    const before = sharedOverlayMaterialCount();
    const mat = (first.added.children[0] as Mesh).material as Material;
    for (let i = 0; i < 50; i++) disposeOverlay(build(overlay).root);
    expect(sharedOverlayMaterialCount()).toBe(before);
    expect((build(overlay).added.children[0] as Mesh).material).toBe(mat);
    let disposed = false;
    mat.addEventListener('dispose', () => {
      disposed = true;
    });
    disposeOverlay(first.root);
    expect(disposed).toBe(false);
  });

  it('removed material is drawn without depth test, added with', () => {
    const c = build(overlay);
    expect(((c.added.children[0] as Mesh).material as Material).depthTest).toBe(true);
    expect(((c.removed.children[0] as Mesh).material as Material).depthTest).toBe(false);
  });
});
