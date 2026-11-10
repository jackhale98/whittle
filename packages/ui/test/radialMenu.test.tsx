import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RADIAL_REPEAT_ID, type RadialItem, RadialMenu, type RadialMenuProps } from '../src';
import {
  clampCenter,
  layoutSlots,
  RADIAL_SLOTS,
  slotDirection,
  slotFromDigitCode,
  slotFromVector,
  stepSlot,
} from '../src/logic/radial';
import { renderUI } from './helpers';

describe('radial geometry', () => {
  it('maps a movement to one of eight 45 degree sectors, clockwise from north', () => {
    const d = 100;
    expect(slotFromVector(0, -d, 10)).toBe('n');
    expect(slotFromVector(d, -d, 10)).toBe('ne');
    expect(slotFromVector(d, 0, 10)).toBe('e');
    expect(slotFromVector(d, d, 10)).toBe('se');
    expect(slotFromVector(0, d, 10)).toBe('s');
    expect(slotFromVector(-d, d, 10)).toBe('sw');
    expect(slotFromVector(-d, 0, 10)).toBe('w');
    expect(slotFromVector(-d, -d, 10)).toBe('nw');
  });

  it('sector edges are at 22.5 degrees', () => {
    const at = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return slotFromVector(Math.sin(a) * 100, -Math.cos(a) * 100, 10);
    };
    expect(at(22)).toBe('n');
    expect(at(23)).toBe('ne');
    expect(at(-22)).toBe('n');
    expect(at(-23)).toBe('nw');
    expect(at(180)).toBe('s');
    expect(at(202)).toBe('s');
    expect(at(203)).toBe('sw');
  });

  it('needs the distance threshold: shorter or zero movements select nothing', () => {
    expect(slotFromVector(0, -39, 40)).toBeNull();
    expect(slotFromVector(0, -40, 40)).toBe('n');
    expect(slotFromVector(0, 0, 0)).toBeNull();
    expect(slotFromVector(28, -28, 40)).toBeNull(); // 39.6 px diagonally
  });

  it('slot directions are unit vectors that map back to their own slot', () => {
    for (const s of RADIAL_SLOTS) {
      const v = slotDirection(s);
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
      expect(slotFromVector(v.x * 50, v.y * 50, 10)).toBe(s);
    }
  });

  it('lays out items clockwise from north-east and keeps north for Repeat', () => {
    const items = ['a', 'b', 'c'].map((id) => ({ id }));
    const { placed, overflow } = layoutSlots(items, ['n']);
    expect(placed.ne?.id).toBe('a');
    expect(placed.e?.id).toBe('b');
    expect(placed.se?.id).toBe('c');
    expect(placed.n).toBeUndefined();
    expect(overflow).toEqual([]);
  });

  it('honours pinned slots, moves a duplicate on and overflows past eight', () => {
    const { placed } = layoutSlots(
      [
        { id: 'a', slot: 'e' as const },
        { id: 'b', slot: 'e' as const },
      ],
      [],
    );
    expect(placed.e?.id).toBe('a');
    expect(placed.ne?.id).toBe('b');
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `i${i}` }));
    const r = layoutSlots(many, ['n']);
    expect(Object.keys(r.placed)).toHaveLength(7);
    expect(r.overflow.map((x) => x.id)).toEqual(['i7', 'i8']);
  });

  it('clamps the centre to the viewport and centres when it cannot fit', () => {
    const half = { x: 170, y: 140 };
    const vp = { width: 1000, height: 800 };
    expect(clampCenter({ x: 5, y: 5 }, half, vp)).toEqual({ x: 178, y: 148 });
    expect(clampCenter({ x: 995, y: 795 }, half, vp)).toEqual({ x: 822, y: 652 });
    expect(clampCenter({ x: 500, y: 400 }, half, vp)).toEqual({ x: 500, y: 400 });
    expect(clampCenter({ x: 10, y: 10 }, half, { width: 300, height: 200 })).toEqual({
      x: 150,
      y: 100,
    });
  });

  it('digit codes pick slots 1-8 clockwise from north', () => {
    expect(slotFromDigitCode('Digit1')).toBe('n');
    expect(slotFromDigitCode('Digit3')).toBe('e');
    expect(slotFromDigitCode('Numpad8')).toBe('nw');
    expect(slotFromDigitCode('Digit9')).toBeNull();
    expect(slotFromDigitCode('KeyA')).toBeNull();
  });

  it('steps between occupied slots only, wrapping', () => {
    const occ = new Set(['n', 'e', 'w'] as const);
    expect(stepSlot(occ, 'n', 1)).toBe('e');
    expect(stepSlot(occ, 'e', 1)).toBe('w');
    expect(stepSlot(occ, 'w', 1)).toBe('n');
    expect(stepSlot(occ, 'n', -1)).toBe('w');
    expect(stepSlot(new Set(), 'n', 1)).toBeNull();
  });
});

const items: RadialItem[] = [
  { id: 'extrude', label: 'Extrude' },
  { id: 'fillet', label: 'Fillet' },
  { id: 'hide', label: 'Hide' },
  { id: 'delete', label: 'Delete', disabled: true },
];

function setup(props: Partial<RadialMenuProps> = {}) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const view = renderUI(
    <RadialMenu
      at={{ x: 400, y: 300 }}
      items={items}
      repeat={{ label: 'Sketch' }}
      onSelect={onSelect}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onSelect, onCancel, ...view };
}

const move = (x: number, y: number) =>
  fireEvent.pointerMove(document, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' });
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('RadialMenu: flick and timing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('draws at once by default (ADR-076): a labelled menu with Repeat in the north slot', () => {
    setup();
    const menu = screen.getByRole('menu', { name: 'Commands' });
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Repeat Sketch', 'Extrude', 'Fillet', 'Hide', 'Delete']);
    expect(menu.querySelector('[data-slot="n"]')).toHaveAttribute('data-item', RADIAL_REPEAT_ID);
    expect(menu.querySelector('[data-slot="ne"]')).toHaveAttribute('data-item', 'extrude');
  });

  it('an optional drawDelay defers drawing; a flick before it has drawn still selects', () => {
    const a = setup({ drawDelay: 250 });
    expect(screen.queryByRole('menu')).toBeNull();
    wait(249);
    expect(screen.queryByRole('menu')).toBeNull();
    wait(2);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    a.unmount();
    const { onSelect } = setup({ drawDelay: 250 });
    wait(100);
    move(400 + 41, 300); // east, past the 40 px threshold
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('fillet');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a flick right after it has drawn selects; after the 250 ms window it does not', () => {
    const a = setup();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    wait(200);
    move(400 + 60, 300);
    expect(a.onSelect).toHaveBeenCalledExactlyOnceWith('fillet');
    a.unmount();
    const b = setup();
    wait(251);
    move(400 + 60, 300);
    expect(b.onSelect).not.toHaveBeenCalled();
  });

  it('flickWindow 0 turns flicks off; keyboard and touch never flick', () => {
    const a = setup({ flickWindow: 0 });
    move(400 + 60, 300);
    expect(a.onSelect).not.toHaveBeenCalled();
    a.unmount();
    const b = setup({ source: 'keyboard' });
    move(400 + 60, 300);
    expect(b.onSelect).not.toHaveBeenCalled();
  });

  it('a menu pushed in from a screen edge takes no flick once drawn', () => {
    const { onSelect } = setup({ at: { x: 5, y: 300 } });
    move(5 + 60, 300);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('flicks north for Repeat, north-east for the first item', () => {
    const a = setup();
    move(400, 300 - 60);
    expect(a.onSelect).toHaveBeenCalledWith(RADIAL_REPEAT_ID);
    a.unmount();
    const b = setup();
    move(400 + 45, 300 - 45);
    expect(b.onSelect).toHaveBeenCalledWith('extrude');
  });

  it('does not select below the distance threshold', () => {
    const { onSelect } = setup();
    move(400 + 39, 300);
    expect(onSelect).not.toHaveBeenCalled();
    move(400 + 40, 300);
    expect(onSelect).toHaveBeenCalledWith('fillet');
  });

  it('ignores a flick toward an empty slot and toward a disabled item', () => {
    const { onSelect } = setup();
    move(400 - 60, 300); // west: empty
    move(400, 300 + 60); // south: Delete, disabled
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('after it has drawn, moving the pointer does not select; clicking an item does', async () => {
    const { onSelect } = setup();
    wait(260);
    move(400 + 80, 300);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fillet' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('fillet');
  });

  it('selects once: a click after a flick is ignored', () => {
    const { onSelect } = setup({ drawDelay: 0 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fillet' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('draws at once for keyboard and touch sources', () => {
    setup({ source: 'keyboard' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('a menu without Repeat has a free north slot', () => {
    setup({ repeat: null, drawDelay: 0 });
    expect(screen.queryByRole('menuitem', { name: /Repeat/ })).toBeNull();
  });
});

describe('RadialMenu: cancellation and stale clicks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Esc cancels, before and after drawing', () => {
    const a = setup();
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(a.onCancel).toHaveBeenCalledTimes(1);
    a.unmount();
    const b = setup();
    wait(300);
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(b.onCancel).toHaveBeenCalledTimes(1);
  });

  it('a press outside cancels and its click never reaches what is behind', () => {
    const behind = vi.fn();
    document.addEventListener('click', behind); // bubble phase: sees only un-swallowed clicks
    const { onCancel, onSelect } = setup();
    wait(300);
    fireEvent.pointerDown(document.body, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(document.body, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.click(document.body);
    expect(behind).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    // The swallow is one-shot: the next click is normal again.
    fireEvent.click(document.body);
    expect(behind).toHaveBeenCalledTimes(1);
    document.removeEventListener('click', behind);
  });

  it('a press that began before it opened never selects: release over an item does nothing', () => {
    const { onSelect, onCancel } = setup({ drawDelay: 0 });
    // No pointerdown was seen after mount, only the release (the right-click that opened it).
    fireEvent.pointerUp(screen.getByRole('menuitem', { name: 'Fillet' }), {
      clientX: 480,
      clientY: 300,
      pointerId: 1,
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('cancels on pointercancel, window blur and resize', () => {
    for (const fire of [
      () => fireEvent.pointerCancel(document),
      () => fireEvent.blur(window),
      () => fireEvent(window, new Event('resize')),
    ]) {
      const { onCancel, unmount } = setup();
      fire();
      expect(onCancel).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('suppresses the native context menu while open', () => {
    setup({ drawDelay: 0 });
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('removes its listeners when unmounted', () => {
    const { onSelect, unmount } = setup();
    unmount();
    move(500, 300);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('RadialMenu: touch (held pointer)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const up = (x: number, y: number) =>
    fireEvent.pointerUp(document, { clientX: x, clientY: y, pointerId: 7, pointerType: 'touch' });

  it('draws at once and selects the item the finger is dragged to when it lifts', () => {
    const { onSelect } = setup({ source: 'touch', held: true, pointerId: 7 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerMove(document, { clientX: 450, clientY: 350, pointerId: 7 });
    expect(screen.getByRole('menuitem', { name: 'Hide' })).toHaveAttribute('data-active');
    expect(onSelect).not.toHaveBeenCalled(); // dragging alone never selects
    up(450, 350);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('hide');
  });

  it('lifting with no direction keeps the menu open for a tap', () => {
    const { onSelect, onCancel } = setup({ source: 'touch', held: true, pointerId: 7 });
    up(402, 301);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Extrude' }));
    expect(onSelect).toHaveBeenCalledWith('extrude');
  });

  it('ignores another finger lifting', () => {
    const { onSelect } = setup({ source: 'touch', held: true, pointerId: 7 });
    fireEvent.pointerUp(document, { clientX: 400, clientY: 370, pointerId: 9 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('eats the click that follows the lift', () => {
    const behind = vi.fn();
    document.addEventListener('click', behind);
    setup({ source: 'touch', held: true, pointerId: 7 });
    up(480, 300);
    fireEvent.click(document.body);
    expect(behind).not.toHaveBeenCalled();
    document.removeEventListener('click', behind);
  });

  it('a pre-draw flick on a held pointer waits for the release', () => {
    const { onSelect } = setup({ source: 'mouse', held: true, pointerId: 7 });
    move(480, 300);
    expect(onSelect).not.toHaveBeenCalled();
    up(480, 300);
    expect(onSelect).toHaveBeenCalledWith('fillet');
  });
});

describe('RadialMenu: held key', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('releasing the key selects by the pointer direction, or cancels without one', () => {
    const a = setup({ holdCode: 'KeyQ' });
    move(450, 350);
    expect(a.onSelect).not.toHaveBeenCalled(); // no blind flick select while the key is held
    fireEvent.keyUp(document, { code: 'KeyQ' });
    expect(a.onSelect).toHaveBeenCalledWith('hide');
    a.unmount();
    const b = setup({ holdCode: 'KeyQ' });
    fireEvent.keyUp(document, { code: 'KeyQ' });
    expect(b.onCancel).toHaveBeenCalled();
  });
});

describe('RadialMenu: keyboard and screen reader', () => {
  it('is a menu of labelled menuitems with a digit shortcut each', () => {
    setup({ source: 'keyboard' });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Repeat Sketch' })).toHaveAttribute(
      'aria-keyshortcuts',
      '1',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Fillet' })).toHaveAttribute(
      'aria-keyshortcuts',
      '3',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('focuses the first enabled slot, arrows move, Enter selects', async () => {
    const { onSelect } = setup({ source: 'keyboard' });
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Repeat Sketch' })).toHaveFocus(),
    );
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Extrude' })).toHaveFocus());
    await userEvent.keyboard('{ArrowRight}{ArrowLeft}{ArrowLeft}');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Repeat Sketch' })).toHaveFocus(),
    );
    await userEvent.keyboard('{ArrowLeft}'); // wraps to the last enabled slot (Hide; Delete is disabled)
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Hide' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('hide');
  });

  it('a digit key selects its slot', async () => {
    const { onSelect } = setup({ source: 'keyboard' });
    await userEvent.keyboard('4'); // slot se: Hide
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('hide');
  });

  it('digits skip disabled items', async () => {
    const { onSelect } = setup({ source: 'keyboard' });
    await userEvent.keyboard('5'); // s = Delete (disabled)
    await userEvent.keyboard('8'); // nw: empty
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.keyboard('1');
    expect(onSelect).toHaveBeenCalledWith(RADIAL_REPEAT_ID);
  });

  it('digit keys use the physical key (code), so a non-QWERTY layout works', () => {
    const { onSelect } = setup({ source: 'keyboard' });
    fireEvent.keyDown(document, { key: '&', code: 'Digit1' }); // AZERTY: unshifted 1 types &
    expect(onSelect).toHaveBeenCalledWith(RADIAL_REPEAT_ID);
  });

  it('returns focus to where it was', () => {
    const btn = document.createElement('button');
    document.body.append(btn);
    btn.focus();
    const { unmount } = setup({ source: 'keyboard' });
    unmount();
    expect(btn).toHaveFocus();
    btn.remove();
  });

  it('clamps to the viewport edges', () => {
    setup({ at: { x: 2, y: 2 }, source: 'keyboard' });
    const root = screen.getByRole('menu');
    // Half extents: the ring plus half a pill, plus the 8 px margin.
    // (jsdom's viewport is 1024 wide, so the wide pills: ring 136 + 64, ring 136 + 17.)
    expect(Number(root.dataset.centerX)).toBe(136 + 64 + 8);
    expect(Number(root.dataset.centerY)).toBe(136 + 17 + 8);
  });
});
