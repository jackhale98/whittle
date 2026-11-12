import type { NavigationOptions } from '@wren-cad/contracts';
import { DEFAULT_COMMANDS, findConflicts, resolveKeymap } from '@wren-cad/ui';
import { describe, expect, it } from 'vitest';
import {
  APP_COMMANDS,
  commandFor,
  type InputSettings,
  RADIAL_COMMAND,
  readRightClickFinishes,
  SKETCH_INPUT_KEY,
  sanitizeOverrides,
  withKeymap,
  withRightClickFinishes,
} from './input';

const navigation: NavigationOptions = {
  preset: 'rightOrbit',
  orbit: 'turntable',
  pivot: 'cursor',
  showPivot: true,
  invertZoom: false,
  rotateSpeed: 1,
  projection: 'orthographic',
};

const settings = (keymap = {}): InputSettings => ({
  navigation,
  keymap,
  resolved: resolveKeymap(APP_COMMANDS, keymap),
});

describe('app keymap', () => {
  it('the radial key is free in every context', () => {
    const resolved = resolveKeymap(APP_COMMANDS);
    for (const b of RADIAL_COMMAND.defaults) {
      const c = findConflicts(APP_COMMANDS, resolved, RADIAL_COMMAND.id, b, 'linux');
      expect(c.commands).toEqual([]);
      expect(c.reserved).toBeUndefined();
    }
    expect(DEFAULT_COMMANDS.some((c) => c.defaults.includes('KeyQ'))).toBe(false);
  });

  it('matches by physical key in the active contexts', () => {
    const s = settings();
    expect(commandFor(s, 'KeyE', false)?.id).toBe('tool:extrude');
    expect(commandFor(s, 'KeyE', true)?.id).toBe('sketch:extend');
    expect(commandFor(s, 'Shift+KeyE', true)?.id).toBe('sketch:ellipse');
    expect(commandFor(s, 'Mod+KeyZ', true)?.id).toBe('undo');
    expect(commandFor(s, 'KeyQ', true)?.id).toBe('radial');
    expect(commandFor(s, 'KeyB', false)).toBeUndefined(); // a sketch-only key
  });

  it('follows overrides, and an unbound command stops firing', () => {
    const s = settings({ 'tool:extrude': ['KeyJ'], 'tool:fillet': [] });
    expect(commandFor(s, 'KeyJ', false)?.id).toBe('tool:extrude');
    expect(commandFor(s, 'KeyE', false)).toBeUndefined();
    expect(commandFor(s, 'KeyF', false)).toBeUndefined();
  });

  it('sanitises stored overrides and applies new ones', () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides({ 'view:front': ['KeyA', 3], 'view:top': 'x' })).toEqual({
      'view:front': ['KeyA'],
    });
    // Unknown ids and prototype keys are dropped, never assigned onto a prototype.
    const hostile = JSON.parse(
      '{"__proto__": ["KeyZ"], "constructor": ["KeyY"], "nope": ["KeyX"]}',
    );
    const clean = sanitizeOverrides(hostile);
    expect(Object.keys(clean)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const next = withKeymap(settings(), { 'tool:extrude': ['KeyJ'] });
    expect(commandFor(next, 'KeyJ', false)?.id).toBe('tool:extrude');
  });
  it('M3.8: "Right click finishes the current sketch tool" is on by default and persists', () => {
    const store = new Map<string, string>();
    const prev = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });
    try {
      expect(readRightClickFinishes()).toBe(true);
      const off = withRightClickFinishes(settings(), false);
      expect(off.rightClickFinishes).toBe(false);
      expect(readRightClickFinishes()).toBe(false);
      withRightClickFinishes(off, true);
      expect(store.has(SKETCH_INPUT_KEY)).toBe(false);
      store.set(SKETCH_INPUT_KEY, '{not json');
      expect(readRightClickFinishes()).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prev });
    }
  });
});
