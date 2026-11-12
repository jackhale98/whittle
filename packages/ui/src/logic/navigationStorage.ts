import {
  DEFAULT_NAVIGATION,
  type NavigationOptions,
  type NavigationPreset,
} from '@wren-cad/contracts';
import { readJson, writeJson } from './persist';

/** localStorage key for the navigation settings (per device: a laptop and a desktop differ). */
export const NAVIGATION_KEY = 'wren.navigation';

const PRESETS: readonly NavigationPreset[] = [
  'rightOrbit',
  'middleOrbit',
  'middlePan',
  'rightOrbitRepeat',
];

/** Clamp and default anything stored: old versions, hand-edited values, other types. */
export function sanitizeNavigation(raw: unknown): NavigationOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_NAVIGATION;
  const speed =
    typeof o.rotateSpeed === 'number' && Number.isFinite(o.rotateSpeed)
      ? o.rotateSpeed
      : d.rotateSpeed;
  return {
    preset: PRESETS.includes(o.preset as NavigationPreset)
      ? (o.preset as NavigationPreset)
      : d.preset,
    orbit: o.orbit === 'trackball' || o.orbit === 'turntable' ? o.orbit : d.orbit,
    pivot: o.pivot === 'center' || o.pivot === 'cursor' ? o.pivot : d.pivot,
    showPivot: typeof o.showPivot === 'boolean' ? o.showPivot : d.showPivot,
    invertZoom: typeof o.invertZoom === 'boolean' ? o.invertZoom : d.invertZoom,
    rotateSpeed: Math.min(4, Math.max(0.25, speed)),
    projection:
      o.projection === 'perspective' || o.projection === 'orthographic'
        ? o.projection
        : d.projection,
  };
}

export function readNavigation(): NavigationOptions {
  return sanitizeNavigation(readJson<unknown>(NAVIGATION_KEY, null));
}

export function writeNavigation(value: NavigationOptions): void {
  writeJson(NAVIGATION_KEY, sanitizeNavigation(value));
}
