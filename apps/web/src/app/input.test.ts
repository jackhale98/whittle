import type { NavigationOptions } from '@wren-cad/contracts';
import { DEFAULT_COMMANDS, findConflicts, resolveKeymap } from '@wren-cad/ui';
import { describe, expect, it } from 'vitest';
import {
  APP_COMMANDS,
  commandFor,
  type InputSettings,
  RADIAL_COMMAND,
  sanitizeOverrides,
  withKeymap,
} from './input';

const navigation: NavigationOptions = {
  preset: 'rightOrbit',
  orbit: 'turntable',
  pivot: 'cursor',
  showPivot: true,
  invertZoom: false,
  rotateSpeed: 1,
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
    expect(sanitizeOverrides({ a: ['KeyA', 3], b: 'x' })).toEqual({ a: ['KeyA'] });
    const next = withKeymap(settings(), { 'tool:extrude': ['KeyJ'] });
    expect(commandFor(next, 'KeyJ', false)?.id).toBe('tool:extrude');
  });
});
