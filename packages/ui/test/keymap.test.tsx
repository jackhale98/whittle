import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_RESERVED,
  DEFAULT_COMMANDS,
  eventToBinding,
  findConflicts,
  findReserved,
  formatBindingId,
  formatBindingLabel,
  KeymapEditor,
  type KeymapOverrides,
  keyLabel,
  matchCommand,
  normalizeBindingId,
  type Platform,
  parseBinding,
  readLayoutMap,
  reservedFor,
  resolveKeymap,
  ShortcutOverlay,
  useModifierHold,
} from '../src';
import { renderUI } from './helpers';

const key = (
  code: string,
  mods: Partial<Record<'ctrl' | 'meta' | 'alt' | 'shift', boolean>> = {},
) => ({
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe('bindings by KeyboardEvent.code', () => {
  it('round-trips and canonicalises the id', () => {
    const b = parseBinding('Shift+Mod+KeyZ');
    expect(b).toEqual({ code: 'KeyZ', mod: true, alt: false, shift: true });
    expect(b && formatBindingId(b)).toBe('Mod+Shift+KeyZ');
    expect(normalizeBindingId('alt+KeyA')).toBeNull(); // modifier names are case-sensitive
    expect(normalizeBindingId('Alt+KeyA')).toBe('Alt+KeyA');
    expect(parseBinding('Mod+ControlLeft')).toBeNull();
    expect(parseBinding('Hyper+KeyA')).toBeNull();
    expect(parseBinding('')).toBeNull();
  });

  it('Mod is Ctrl on Windows and Linux, Cmd on macOS; the other one is not bindable', () => {
    expect(eventToBinding(key('KeyS', { ctrl: true }), 'win')).toEqual({
      code: 'KeyS',
      mod: true,
      alt: false,
      shift: false,
    });
    expect(eventToBinding(key('KeyS', { meta: true }), 'mac')?.mod).toBe(true);
    expect(eventToBinding(key('KeyS', { ctrl: true }), 'mac')).toBeNull();
    expect(eventToBinding(key('KeyS', { meta: true }), 'linux')).toBeNull();
  });

  it('ignores a bare modifier and unidentified keys', () => {
    expect(eventToBinding(key('ShiftLeft', { shift: true }), 'win')).toBeNull();
    expect(eventToBinding(key('ControlRight', { ctrl: true }), 'win')).toBeNull();
    expect(eventToBinding(key('Unidentified'), 'win')).toBeNull();
    expect(eventToBinding(key(''), 'win')).toBeNull();
  });

  it('a shortcut is the same physical key on QWERTY, AZERTY and Dvorak', () => {
    const resolved = resolveKeymap(DEFAULT_COMMANDS);
    // The key that types "e" on QWERTY is KeyE; on AZERTY the same physical key types "e" too,
    // but the physical KeyQ key types "a" there, so "a" (Arc) must be found by code KeyA, not key.
    const arcOnAzerty: object = { ...key('KeyA'), key: 'q' };
    const id = formatBindingId(
      eventToBinding(arcOnAzerty as ReturnType<typeof key>, 'win') as never,
    );
    expect(matchCommand(DEFAULT_COMMANDS, resolved, id, ['sketch', 'global'])?.id).toBe(
      'sketch:arc',
    );
    // And the key that types "z" on QWERTY but "y" on QWERTZ is still undo with Ctrl.
    const undo = formatBindingId(
      eventToBinding({ ...key('KeyZ', { ctrl: true }), key: 'y' }, 'win') as never,
    );
    expect(matchCommand(DEFAULT_COMMANDS, resolved, undo, ['model', 'global'])?.id).toBe('undo');
  });
});

describe('labels', () => {
  const dvorak = { get: (c: string) => ({ KeyS: 'o', KeyA: 'a', Semicolon: 's' })[c] };
  it('uses the layout map when it has the key, else the QWERTY label', () => {
    expect(keyLabel('KeyS', dvorak)).toBe('O');
    expect(keyLabel('KeyQ', dvorak)).toBe('Q');
    expect(keyLabel('KeyS')).toBe('S');
    expect(keyLabel('Digit1')).toBe('1');
    expect(keyLabel('ArrowUp', dvorak)).toBe('↑');
    expect(keyLabel('Escape')).toBe('Esc');
  });
  it('formats by platform', () => {
    expect(formatBindingLabel('Mod+Shift+KeyZ', { platform: 'win' })).toBe('Ctrl+Shift+Z');
    expect(formatBindingLabel('Mod+Shift+KeyZ', { platform: 'mac' })).toBe('⇧⌘Z');
    expect(formatBindingLabel('Mod+KeyS', { platform: 'win', layout: dvorak })).toBe('Ctrl+O');
    expect(formatBindingLabel('Alt+KeyS', { platform: 'mac' })).toBe('⌥S');
  });
  it('readLayoutMap works where the API exists and is undefined where it does not', async () => {
    expect(await readLayoutMap({})).toBeUndefined();
    const map = { get: () => 'x' };
    expect(await readLayoutMap({ keyboard: { getLayoutMap: async () => map } })).toBe(map);
    expect(
      await readLayoutMap({
        keyboard: {
          getLayoutMap: async () => {
            throw new Error('permissions policy');
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe('browser-reserved shortcuts', () => {
  it('lists the chords the browser keeps, with notes, on the right platforms', () => {
    for (const id of [
      'Mod+KeyW',
      'Mod+KeyT',
      'Mod+KeyN',
      'Mod+KeyQ',
      'Mod+KeyL',
      'Tab',
      'Shift+Tab',
      'F5',
      'F11',
      'F12',
    ]) {
      const r = BROWSER_RESERVED.find((x) => x.binding === id);
      expect(r, id).toBeDefined();
      expect(r?.notes.length, id).toBeGreaterThan(0);
      expect(r?.action).toBeTruthy();
    }
    expect(findReserved('Mod+KeyW', 'mac')?.severity).toBe('blocked');
    expect(findReserved('Mod+KeyS', 'win')?.severity).toBe('preventable');
    expect(findReserved('F11', 'mac')).toBeUndefined(); // macOS full screen is a different chord
    expect(findReserved('F11', 'win')?.severity).toBe('blocked');
    expect(findReserved('Mod+KeyQ', 'win')).toBeUndefined();
    expect(findReserved('Shift+Mod+KeyW', 'win')?.action).toBe('Close window');
    expect(findReserved('KeyE', 'win')).toBeUndefined();
    expect(reservedFor('other')).toBe(BROWSER_RESERVED);
  });

  it('is well formed: unique, canonical bindings', () => {
    const seen = new Set<string>();
    for (const r of BROWSER_RESERVED) {
      expect(normalizeBindingId(r.binding), r.binding).toBe(r.binding);
      expect(seen.has(r.binding), `duplicate ${r.binding}`).toBe(false);
      seen.add(r.binding);
    }
  });
});

describe('default keymap', () => {
  const resolved = resolveKeymap(DEFAULT_COMMANDS);

  it('every default binding is valid and canonical', () => {
    for (const c of DEFAULT_COMMANDS)
      for (const b of c.defaults) expect(normalizeBindingId(b), `${c.id} ${b}`).toBe(b);
  });

  it('has no conflicts between commands in overlapping contexts', () => {
    for (const c of DEFAULT_COMMANDS)
      for (const b of resolved[c.id] ?? []) {
        const f = findConflicts(DEFAULT_COMMANDS, resolved, c.id, b, 'win');
        expect(
          f.commands.map((x) => x.id),
          `${c.id} ${b}`,
        ).toEqual([]);
      }
  });

  it('claims no browser key the page can never receive', () => {
    for (const platform of ['win', 'mac', 'linux'] as const)
      for (const c of DEFAULT_COMMANDS)
        for (const b of resolved[c.id] ?? [])
          expect(findReserved(b, platform)?.severity, `${c.id} ${b} on ${platform}`).not.toBe(
            'blocked',
          );
  });

  it('the new curve tools do not clash with existing sketch shortcuts', () => {
    const sketch = DEFAULT_COMMANDS.filter((c) => c.context === 'sketch');
    const byBinding = new Map<string, string[]>();
    for (const c of sketch)
      for (const b of c.defaults) byBinding.set(b, [...(byBinding.get(b) ?? []), c.id]);
    for (const [b, ids] of byBinding) expect(ids, b).toHaveLength(1);
    expect(resolved['sketch:splineControl']).toEqual(['KeyB']);
    expect(resolved['sketch:splineThrough']).toEqual(['Shift+KeyB']);
    expect(resolved['sketch:ellipse']).toEqual(['Shift+KeyE']);
    expect(resolved['sketch:ellipticArc']).toEqual(['Shift+KeyA']);
  });

  it('context decides: P is Point while sketching and Push/pull otherwise; global keys work in both', () => {
    expect(matchCommand(DEFAULT_COMMANDS, resolved, 'KeyP', ['sketch', 'global'])?.id).toBe(
      'sketch:point',
    );
    expect(matchCommand(DEFAULT_COMMANDS, resolved, 'KeyP', ['model', 'global'])?.id).toBe(
      'tool:pushPull',
    );
    expect(matchCommand(DEFAULT_COMMANDS, resolved, 'Mod+KeyZ', ['sketch', 'global'])?.id).toBe(
      'undo',
    );
    expect(matchCommand(DEFAULT_COMMANDS, resolved, 'KeyL', ['model', 'global'])).toBeUndefined();
  });

  it('overrides replace defaults, [] unbinds, locked commands cannot change, bad ids are dropped', () => {
    const r = resolveKeymap(DEFAULT_COMMANDS, {
      'tool:extrude': ['KeyJ', 'Hyper+KeyA'],
      'tool:fillet': [],
      cancel: ['KeyQ'],
    });
    expect(r['tool:extrude']).toEqual(['KeyJ']);
    expect(r['tool:fillet']).toEqual([]);
    expect(r.cancel).toEqual(['Escape']);
  });

  it('reports a conflict with another command and with a browser key', () => {
    const f = findConflicts(DEFAULT_COMMANDS, resolved, 'tool:extrude', 'KeyF', 'win');
    expect(f.commands.map((c) => c.id)).toEqual(['tool:fillet']);
    expect(
      findConflicts(DEFAULT_COMMANDS, resolved, 'tool:extrude', 'Mod+KeyW', 'win').reserved?.action,
    ).toBe('Close tab');
    // A model-only command may reuse a sketch-only command's key.
    expect(findConflicts(DEFAULT_COMMANDS, resolved, 'tool:sweep', 'KeyL', 'win').commands).toEqual(
      [],
    );
    // A global command conflicts with both.
    expect(
      findConflicts(DEFAULT_COMMANDS, resolved, 'view:iso', 'KeyL', 'win').commands.map(
        (c) => c.id,
      ),
    ).toEqual(['sketch:line']);
  });
});

function Editor({ platform = 'win' as Platform, initial = {} as KeymapOverrides, spy = vi.fn() }) {
  const [o, setO] = useState<KeymapOverrides>(initial);
  return (
    <KeymapEditor
      commands={DEFAULT_COMMANDS}
      overrides={o}
      platform={platform}
      onChange={(next) => {
        spy(next);
        setO(next);
      }}
    />
  );
}

async function record(user: ReturnType<typeof userEvent.setup>, command: string, chord: string) {
  await user.click(screen.getByRole('button', { name: `Add shortcut for ${command}` }));
  await user.keyboard(chord);
}

describe('KeymapEditor', () => {
  it('lists commands by group with their bindings and a search', async () => {
    const user = userEvent.setup();
    renderUI(<Editor />);
    const row = document.querySelector('[data-command="tool:extrude"]') as HTMLElement;
    expect(within(row).getByText('Extrude')).toBeInTheDocument();
    expect(within(row).getByText('E')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: /Search commands/ }), 'spline');
    expect(screen.getByText('Spline (control points)')).toBeInTheDocument();
    expect(screen.queryByText('Extrude')).toBeNull();
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText(/No command matches/)).toBeInTheDocument();
  });

  it('records a free key by code and applies it', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderUI(<Editor spy={spy} />);
    await record(user, 'Extrude', 'j');
    expect(spy).toHaveBeenLastCalledWith({ 'tool:extrude': ['KeyE', 'KeyJ'] });
    expect(screen.queryByTestId('keymap-conflict')).toBeNull();
    const row = document.querySelector('[data-command="tool:extrude"]') as HTMLElement;
    expect(row).toHaveAttribute('data-modified');
  });

  it('flags a conflict with another command and offers to reassign', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderUI(<Editor spy={spy} />);
    await record(user, 'Extrude', 'f');
    const note = await screen.findByTestId('keymap-conflict');
    expect(note).toHaveTextContent('already used by Fillet');
    expect(spy).not.toHaveBeenCalled(); // nothing applied yet
    await user.click(within(note).getByRole('button', { name: 'Reassign here' }));
    expect(spy).toHaveBeenLastCalledWith({ 'tool:fillet': [], 'tool:extrude': ['KeyE', 'KeyF'] });
  });

  it('flags Ctrl+W and Ctrl+T as browser shortcuts the page never receives, and refuses them', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderUI(<Editor spy={spy} />);
    await record(user, 'Extrude', '{Control>}w{/Control}');
    let note = await screen.findByTestId('keymap-conflict');
    expect(note).toHaveAttribute('data-severity', 'blocked');
    expect(note).toHaveTextContent('Ctrl+W is a browser shortcut (Close tab)');
    expect(within(note).queryByRole('button', { name: /Use anyway|Reassign/ })).toBeNull();
    await user.click(within(note).getByRole('button', { name: 'Cancel' }));
    await record(user, 'Extrude', '{Control>}t{/Control}');
    note = await screen.findByTestId('keymap-conflict');
    expect(note).toHaveTextContent('Ctrl+T is a browser shortcut (New tab)');
    expect(spy).not.toHaveBeenCalled();
  });

  it('on macOS the same chord is Cmd+W and the label says so', async () => {
    const user = userEvent.setup();
    renderUI(<Editor platform="mac" />);
    await record(user, 'Extrude', '{Meta>}w{/Meta}');
    expect(await screen.findByTestId('keymap-conflict')).toHaveTextContent(
      '⌘W is a browser shortcut',
    );
  });

  it('a browser key the page can cancel needs "Use anyway"', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderUI(<Editor spy={spy} />);
    await record(user, 'Extrude', '{Control>}p{/Control}');
    const note = await screen.findByTestId('keymap-conflict');
    expect(note).toHaveAttribute('data-severity', 'warning');
    expect(note).toHaveTextContent('Print');
    await user.click(within(note).getByRole('button', { name: 'Use anyway' }));
    expect(spy).toHaveBeenLastCalledWith({ 'tool:extrude': ['KeyE', 'Mod+KeyP'] });
  });

  it('Esc cancels recording and a bare modifier keeps waiting', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderUI(<Editor spy={spy} />);
    await user.click(screen.getByRole('button', { name: 'Add shortcut for Extrude' }));
    fireEvent.keyDown(screen.getByTestId('key-recorder'), {
      code: 'ShiftLeft',
      key: 'Shift',
      shiftKey: true,
    });
    expect(screen.getByTestId('key-recorder')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('key-recorder')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('flags existing bindings that are browser keys (Save)', () => {
    renderUI(<Editor />);
    const save = document.querySelector('[data-command="save"] [data-binding="Mod+KeyS"]');
    expect(save).toHaveAttribute('data-flag', 'preventable');
    expect(save).toHaveTextContent('Also a browser shortcut: Save page');
  });

  it('removes a binding, resets one command and resets everything', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderUI(<Editor spy={spy} initial={{ 'tool:extrude': ['KeyJ'], 'tool:fillet': [] }} />);
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Remove J from Extrude' }));
    expect(spy).toHaveBeenLastCalledWith({ 'tool:extrude': [], 'tool:fillet': [] });
    await user.click(screen.getByRole('button', { name: 'Reset Extrude to default' }));
    expect(spy).toHaveBeenLastCalledWith({ 'tool:fillet': [] });
    await user.click(screen.getByRole('button', { name: 'Reset all' }));
    expect(spy).toHaveBeenLastCalledWith({});
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeDisabled();
  });

  it('locked commands (Esc, Space) show no edit buttons', () => {
    renderUI(<Editor />);
    expect(
      screen.queryByRole('button', { name: 'Add shortcut for Cancel / leave tool' }),
    ).toBeNull();
    expect(screen.getByText('Esc')).toBeInTheDocument();
  });
});

describe('ShortcutOverlay', () => {
  const resolved = resolveKeymap(DEFAULT_COMMANDS);
  const show = (
    contexts: ('global' | 'model' | 'sketch')[],
    visible = true,
    held?: 'mod' | 'alt',
  ) =>
    renderUI(
      <ShortcutOverlay
        commands={DEFAULT_COMMANDS}
        resolved={resolved}
        contexts={contexts}
        visible={visible}
        platform="win"
        {...(held ? { held } : {})}
      />,
    );

  it('renders nothing until visible', () => {
    show(['global'], false);
    expect(screen.queryByTestId('shortcut-overlay')).toBeNull();
  });

  it('lists only the shortcuts available in the current context', () => {
    show(['sketch', 'global']);
    const o = screen.getByRole('region', { name: /Keyboard shortcuts available now/ });
    expect(within(o).getByText('Line')).toBeInTheDocument();
    expect(within(o).getByText('Spline (control points)')).toBeInTheDocument();
    expect(within(o).getByText('Undo')).toBeInTheDocument();
    expect(within(o).queryByText('Extrude')).toBeNull();
  });

  it('model context shows the modeling tools and not the sketch ones', () => {
    show(['model', 'global']);
    const o = screen.getByTestId('shortcut-overlay');
    expect(within(o).getByText('Extrude')).toBeInTheDocument();
    expect(within(o).queryByText('Line')).toBeNull();
  });

  it('the held modifier lists its chords first and marks them', () => {
    show(['model', 'global'], true, 'mod');
    const o = screen.getByTestId('shortcut-overlay');
    const general = within(o).getByRole('heading', { name: 'General' })
      .parentElement as HTMLElement;
    const first = general.querySelector('li') as HTMLElement;
    expect(first).toHaveAttribute('data-match');
    expect(o).toHaveAttribute('data-held', 'mod');
  });

  it('is not interactive and takes no focus', () => {
    show(['global']);
    expect(screen.getByTestId('shortcut-overlay').className).toContain('pointer-events-none');
    expect(within(screen.getByTestId('shortcut-overlay')).queryAllByRole('button')).toHaveLength(0);
  });
});

function Hold({ delay }: { delay?: number }) {
  const { visible, held } = useModifierHold(delay === undefined ? {} : { delay });
  return <output data-testid="hold">{visible ? `visible:${held}` : 'hidden'}</output>;
}

describe('useModifierHold (600 ms)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const text = () => screen.getByTestId('hold').textContent;
  const down = (code: string, extra = {}) =>
    fireEvent.keyDown(document, { code, key: code, ...extra });
  const up = (code: string) => fireEvent.keyUp(document, { code, key: code });
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it('shows after 600 ms of holding Ctrl, not before', () => {
    renderUI(<Hold />);
    down('ControlLeft', { ctrlKey: true });
    wait(599);
    expect(text()).toBe('hidden');
    wait(2);
    expect(text()).toBe('visible:mod');
    up('ControlLeft');
    expect(text()).toBe('hidden');
  });

  it('works for Cmd and Alt', () => {
    renderUI(<Hold />);
    down('MetaLeft', { metaKey: true });
    wait(601);
    expect(text()).toBe('visible:mod');
    up('MetaLeft');
    down('AltRight', { altKey: true });
    wait(601);
    expect(text()).toBe('visible:alt');
  });

  it('a chord (Ctrl+Z) cancels it: the user is typing a shortcut, not asking for help', () => {
    renderUI(<Hold />);
    down('ControlLeft', { ctrlKey: true });
    wait(300);
    down('KeyZ', { ctrlKey: true });
    wait(1000);
    expect(text()).toBe('hidden');
  });

  it('a pointer press (Ctrl-click multi-select) or blur hides it', () => {
    renderUI(<Hold />);
    down('ControlLeft', { ctrlKey: true });
    wait(300);
    fireEvent.pointerDown(document.body);
    wait(1000);
    expect(text()).toBe('hidden');
    down('AltLeft', { altKey: true });
    wait(601);
    expect(text()).toBe('visible:alt');
    fireEvent.blur(window);
    expect(text()).toBe('hidden');
  });

  it('key repeat does not restart the clock', () => {
    renderUI(<Hold />);
    down('ControlLeft', { ctrlKey: true });
    wait(400);
    down('ControlLeft', { ctrlKey: true, repeat: true });
    wait(250);
    expect(text()).toBe('visible:mod');
  });

  it('does not cancel the key events (passive)', () => {
    renderUI(<Hold />);
    const ev = new KeyboardEvent('keydown', {
      code: 'ControlLeft',
      cancelable: true,
      bubbles: true,
    });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('honours a custom delay', () => {
    renderUI(<Hold delay={100} />);
    down('ControlLeft', { ctrlKey: true });
    wait(101);
    expect(text()).toBe('visible:mod');
  });
});
