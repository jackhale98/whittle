/**
 * Radial-menu geometry (PLAN 9.4, ADR-046). Pure and DOM-free so the flick rules are unit-tested:
 * eight fixed 45 degree sectors, clockwise from north, the same layout on every surface.
 */

export const RADIAL_SLOTS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type RadialSlot = (typeof RADIAL_SLOTS)[number];

/** Default fill order for items without an explicit slot. North is reserved for "Repeat". */
export const RADIAL_FILL_ORDER: readonly RadialSlot[] = [
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
  'nw',
  'n',
];

export interface Vec {
  x: number;
  y: number;
}

/** Unit direction of a slot in screen space (y grows downward). */
export function slotDirection(slot: RadialSlot): Vec {
  const a = (RADIAL_SLOTS.indexOf(slot) * Math.PI) / 4;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

/**
 * The slot a movement `(dx, dy)` points at (screen coordinates), or null while the movement is
 * shorter than `minDistance`. Sectors are 45 degrees wide and centred on each slot's direction.
 */
export function slotFromVector(dx: number, dy: number, minDistance: number): RadialSlot | null {
  if (Math.hypot(dx, dy) < minDistance || (dx === 0 && dy === 0)) return null;
  const clockwiseFromNorth = Math.atan2(dx, -dy); // -pi..pi
  const sector = Math.round(clockwiseFromNorth / (Math.PI / 4));
  return RADIAL_SLOTS[((sector % 8) + 8) % 8] as RadialSlot;
}

export interface SlotItem {
  id: string;
  slot?: RadialSlot | undefined;
}

/**
 * Assign items to slots. Explicit slots win (a later duplicate moves on); the rest fill the free
 * slots clockwise from north-east. `reserved` slots (the fixed Repeat slot) are never used.
 * At most `8 - reserved.length` items are placed; extras are returned in `overflow`.
 */
export function layoutSlots<T extends SlotItem>(
  items: readonly T[],
  reserved: readonly RadialSlot[] = [],
): { placed: Partial<Record<RadialSlot, T>>; overflow: T[] } {
  const placed: Partial<Record<RadialSlot, T>> = {};
  const taken = new Set<RadialSlot>(reserved);
  const overflow: T[] = [];
  const loose: T[] = [];
  for (const item of items) {
    if (item.slot && !taken.has(item.slot)) {
      placed[item.slot] = item;
      taken.add(item.slot);
    } else loose.push(item);
  }
  for (const item of loose) {
    const free = RADIAL_FILL_ORDER.find((s) => !taken.has(s));
    if (!free) overflow.push(item);
    else {
      placed[free] = item;
      taken.add(free);
    }
  }
  return { placed, overflow };
}

/**
 * Centre for a menu of half-extents `half` opened at `at`, kept `pad` inside the viewport. A
 * viewport smaller than the menu centres it on that axis.
 */
export function clampCenter(
  at: Vec,
  half: Vec,
  viewport: { width: number; height: number },
  pad = 8,
): Vec {
  const axis = (v: number, h: number, size: number) => {
    const lo = h + pad;
    const hi = size - h - pad;
    return lo > hi ? size / 2 : Math.min(Math.max(v, lo), hi);
  };
  return { x: axis(at.x, half.x, viewport.width), y: axis(at.y, half.y, viewport.height) };
}

/** Slot for a digit key code (`Digit1`..`Digit8`, `Numpad1`..`Numpad8`): 1 = north, clockwise. */
export function slotFromDigitCode(code: string): RadialSlot | null {
  const m = /^(?:Digit|Numpad)([1-8])$/.exec(code);
  return m ? (RADIAL_SLOTS[Number(m[1]) - 1] ?? null) : null;
}

/** Next occupied slot clockwise (`step` 1) or counter-clockwise (-1) from `from`. */
export function stepSlot(
  occupied: ReadonlySet<RadialSlot>,
  from: RadialSlot | null,
  step: 1 | -1,
): RadialSlot | null {
  if (occupied.size === 0) return null;
  const start = from ? RADIAL_SLOTS.indexOf(from) : step === 1 ? -1 : 0;
  for (let i = 1; i <= 8; i++) {
    const s = RADIAL_SLOTS[(((start + step * i) % 8) + 8) % 8] as RadialSlot;
    if (occupied.has(s)) return s;
  }
  return null;
}
