/**
 * Keymap model (PLAN 9.4, ADR-046): bindings are `KeyboardEvent.code` (the physical key), so a
 * shortcut sits on the same key on QWERTY, AZERTY and Dvorak. Labels come from the browser's
 * layout map when it has one. Pure and DOM-free (the layout map is passed in).
 *
 * A binding is a canonical string, `Mod+Alt+Shift+<code>`: `Mod` is Cmd on macOS and Ctrl
 * elsewhere. A literal Ctrl on macOS (or Meta elsewhere) is not bindable: it is the OS's.
 */

export type Platform = 'mac' | 'win' | 'linux' | 'other';

export interface Binding {
  /** `KeyboardEvent.code`, e.g. `KeyZ`, `Digit1`, `Space`, `F5`. */
  code: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
  alt: boolean;
  shift: boolean;
}

export function detectPlatform(
  nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator,
): Platform {
  const s = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  if (/Mac|iPhone|iPad|iPod/i.test(s)) return 'mac';
  if (/Win/i.test(s)) return 'win';
  if (/Linux|X11|CrOS/i.test(s)) return 'linux';
  return 'other';
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)$|^(AltGraph|CapsLock|Fn)$/;

/** Canonical string for a binding (`Mod+Shift+KeyZ`). */
export function formatBindingId(b: Binding): string {
  return [b.mod ? 'Mod' : '', b.alt ? 'Alt' : '', b.shift ? 'Shift' : '', b.code]
    .filter(Boolean)
    .join('+');
}

/** Inverse of {@link formatBindingId}; null for malformed input. */
export function parseBinding(id: string): Binding | null {
  const parts = id.split('+');
  const code = parts.pop();
  if (!code || MODIFIER_CODES.test(code)) return null;
  const mods = new Set(parts);
  for (const m of mods) if (m !== 'Mod' && m !== 'Alt' && m !== 'Shift') return null;
  return { code, mod: mods.has('Mod'), alt: mods.has('Alt'), shift: mods.has('Shift') };
}

/** Canonicalise (`shift+mod+KeyZ` -> `Mod+Shift+KeyZ`); null if not parseable. */
export function normalizeBindingId(id: string): string | null {
  const b = parseBinding(id);
  return b ? formatBindingId(b) : null;
}

interface KeyLike {
  code: string;
  /** Not used for matching (that is the point); accepted so real events pass as they are. */
  key?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The binding a key event represents, or null for a bare modifier press or a chord with the OS's
 * own modifier (Ctrl on macOS, Meta elsewhere).
 */
export function eventToBinding(e: KeyLike, platform: Platform = detectPlatform()): Binding | null {
  if (!e.code || e.code === 'Unidentified' || MODIFIER_CODES.test(e.code)) return null;
  const mac = platform === 'mac';
  const mod = mac ? e.metaKey : e.ctrlKey;
  const foreign = mac ? e.ctrlKey : e.metaKey;
  if (foreign) return null;
  return { code: e.code, mod, alt: e.altKey, shift: e.shiftKey };
}

/** Convenience: the canonical id of an event's binding. */
export function eventBindingId(e: KeyLike, platform?: Platform): string | null {
  const b = eventToBinding(e, platform);
  return b ? formatBindingId(b) : null;
}

/* ------------------------------------------------------------------------- labels */

const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Del',
  Tab: 'Tab',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Home: 'Home',
  End: 'End',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '\\',
};

/** Layout-free label: `KeyA` -> A, `Digit1` -> 1, `ArrowUp` -> an arrow. */
export function codeLabel(code: string): string {
  const known = CODE_LABELS[code];
  if (known) return known;
  const key = /^Key([A-Z])$/.exec(code);
  if (key) return key[1] as string;
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1] as string;
  const pad = /^Numpad(\d)$/.exec(code);
  if (pad) return `Num ${pad[1]}`;
  return code;
}

/** `navigator.keyboard.getLayoutMap()` result: physical code -> the character it types. */
export type LayoutMap = { get(code: string): string | undefined };

/** The label this key shows on the user's layout (falls back to the QWERTY-style label). */
export function keyLabel(code: string, layout?: LayoutMap | null): string {
  const ch = layout?.get(code);
  if (ch && ch.length > 0 && !CODE_LABELS[code]) return ch.length === 1 ? ch.toUpperCase() : ch;
  return codeLabel(code);
}

export interface FormatOptions {
  platform?: Platform;
  layout?: LayoutMap | null;
}

/** Display parts of a binding, one per key cap: `['Ctrl', 'Shift', 'Z']` or `['⌘', '⇧', 'Z']`. */
export function bindingParts(b: Binding, { platform, layout }: FormatOptions = {}): string[] {
  const mac = (platform ?? detectPlatform()) === 'mac';
  const parts: string[] = [];
  if (mac) {
    if (b.alt) parts.push('⌥');
    if (b.shift) parts.push('⇧');
    if (b.mod) parts.push('⌘');
  } else {
    if (b.mod) parts.push('Ctrl');
    if (b.alt) parts.push('Alt');
    if (b.shift) parts.push('Shift');
  }
  parts.push(keyLabel(b.code, layout));
  return parts;
}

/** Display text of a binding id (`Ctrl+Shift+Z`; macOS `⇧⌘Z`). Returns the id when unparseable. */
export function formatBindingLabel(id: string, opts: FormatOptions = {}): string {
  const b = parseBinding(id);
  if (!b) return id;
  const parts = bindingParts(b, opts);
  return (opts.platform ?? detectPlatform()) === 'mac' ? parts.join('') : parts.join('+');
}

/** Reads `navigator.keyboard.getLayoutMap()` where supported (Chromium); undefined elsewhere. */
export async function readLayoutMap(
  nav:
    | { keyboard?: { getLayoutMap?: () => Promise<LayoutMap> } }
    | undefined = globalThis.navigator as never,
): Promise<LayoutMap | undefined> {
  try {
    return await nav?.keyboard?.getLayoutMap?.();
  } catch {
    return undefined; // permission policy, insecure context or an iframe
  }
}

/* ------------------------------------------------------------------------- browser-reserved */

/**
 * `blocked`: the browser handles it before the page sees it (or the page cannot cancel it); a
 * binding on it never fires. `preventable`: the page receives the key and may cancel the
 * browser's action, but the user then loses the browser feature while Wren has focus.
 */
export type ReservedSeverity = 'blocked' | 'preventable';

export interface ReservedShortcut {
  /** Canonical binding id, `Mod`-based where the chord is Ctrl on Windows/Linux and Cmd on macOS. */
  binding: string;
  /** What the browser does. */
  action: string;
  severity: ReservedSeverity;
  /** Platforms it applies to. */
  platforms: readonly Exclude<Platform, 'other'>[];
  /** Notes per platform or browser; shown in the keymap editor. */
  notes: readonly string[];
}

const ALL = ['mac', 'win', 'linux'] as const;
const PC = ['win', 'linux'] as const;

/**
 * Browser and OS shortcuts a web app cannot reliably claim (Onshape's forum is a catalogue of the
 * consequences; PLAN 9.4). Behaviour varies by browser version and by whether Wren runs in a tab
 * or as an installed PWA window, so the notes say where it differs. Verified against Chrome,
 * Edge, Firefox and Safari documentation as of 2026; recheck when a browser changes.
 */
export const BROWSER_RESERVED: readonly ReservedShortcut[] = [
  {
    binding: 'Mod+KeyW',
    action: 'Close tab',
    severity: 'blocked',
    platforms: ALL,
    notes: [
      'Chrome, Edge, Firefox and Safari close the tab before the page sees the key.',
      'An installed PWA window still closes on it.',
    ],
  },
  {
    binding: 'Mod+KeyT',
    action: 'New tab',
    severity: 'blocked',
    platforms: ALL,
    notes: ['Never delivered to the page in any major browser.'],
  },
  {
    binding: 'Mod+KeyN',
    action: 'New window',
    severity: 'blocked',
    platforms: ALL,
    notes: [
      'Never delivered in a tab. An installed PWA window may deliver it on Chromium, which varies by version.',
    ],
  },
  {
    binding: 'Mod+Shift+KeyN',
    action: 'New private window',
    severity: 'blocked',
    platforms: ALL,
    notes: ['Chrome and Edge: incognito / InPrivate. Firefox and Safari: private window.'],
  },
  {
    binding: 'Mod+Shift+KeyT',
    action: 'Reopen closed tab',
    severity: 'blocked',
    platforms: ALL,
    notes: ['Not delivered to the page.'],
  },
  {
    binding: 'Mod+Shift+KeyW',
    action: 'Close window',
    severity: 'blocked',
    platforms: ALL,
    notes: ['Not delivered to the page.'],
  },
  {
    binding: 'Mod+KeyQ',
    action: 'Quit the browser',
    severity: 'blocked',
    platforms: ['mac', 'linux'],
    notes: [
      'macOS: Cmd+Q quits the app. Firefox on Linux: Ctrl+Q. Chrome on Linux uses Ctrl+Shift+Q.',
      'Not used on Windows.',
    ],
  },
  {
    binding: 'Mod+Shift+KeyQ',
    action: 'Quit the browser / log out',
    severity: 'blocked',
    platforms: ALL,
    notes: ['Chrome on Linux quits; macOS Cmd+Shift+Q logs out. Not delivered to the page.'],
  },
  {
    binding: 'Mod+KeyL',
    action: 'Focus the address bar',
    severity: 'blocked',
    platforms: ALL,
    notes: [
      'Chrome and Firefox do not let the page cancel it.',
      'In an installed PWA window there is no address bar, but the key is still handled.',
    ],
  },
  {
    binding: 'Alt+KeyD',
    action: 'Focus the address bar',
    severity: 'blocked',
    platforms: PC,
    notes: ['Windows and Linux browsers.'],
  },
  {
    binding: 'Tab',
    action: 'Move keyboard focus',
    severity: 'blocked',
    platforms: ALL,
    notes: [
      'Tab and Shift+Tab are the page focus order; Wren uses them only inside open choosers.',
      'Safari additionally needs Option+Tab to reach every control unless changed in Settings.',
    ],
  },
  {
    binding: 'Shift+Tab',
    action: 'Move keyboard focus backwards',
    severity: 'blocked',
    platforms: ALL,
    notes: ['See Tab.'],
  },
  {
    binding: 'Mod+Tab',
    action: 'Next tab',
    severity: 'blocked',
    platforms: PC,
    notes: [
      'Ctrl+Tab and Ctrl+Shift+Tab switch tabs in every desktop browser; macOS Cmd+Tab is the OS app switcher.',
    ],
  },
  {
    binding: 'Mod+PageDown',
    action: 'Next tab',
    severity: 'blocked',
    platforms: PC,
    notes: ['Ctrl+PageDown / Ctrl+PageUp.'],
  },
  {
    binding: 'Mod+PageUp',
    action: 'Previous tab',
    severity: 'blocked',
    platforms: PC,
    notes: ['See Ctrl+PageDown.'],
  },
  {
    binding: 'F5',
    action: 'Reload',
    severity: 'preventable',
    platforms: ALL,
    notes: [
      'The page may cancel it, but a stuck Wren then cannot be reloaded from the keyboard.',
      'Mod+R and Mod+Shift+R reload too.',
    ],
  },
  {
    binding: 'Mod+KeyR',
    action: 'Reload',
    severity: 'preventable',
    platforms: ALL,
    notes: ['Chrome, Edge, Firefox and Safari. Cmd+Shift+R / Ctrl+Shift+R is a hard reload.'],
  },
  {
    binding: 'F11',
    action: 'Full screen',
    severity: 'blocked',
    platforms: PC,
    notes: ['Windows and Linux: the browser takes it. On macOS use Ctrl+Cmd+F (OS) instead.'],
  },
  {
    binding: 'F12',
    action: 'Developer tools',
    severity: 'blocked',
    platforms: ALL,
    notes: ['Chrome, Edge and Firefox. Safari has no default F12 binding.'],
  },
  {
    binding: 'Mod+Alt+KeyI',
    action: 'Developer tools',
    severity: 'blocked',
    platforms: ALL,
    notes: ['Ctrl+Shift+I on Windows and Linux; Cmd+Option+I on macOS.'],
  },
  {
    binding: 'Alt+ArrowLeft',
    action: 'Back',
    severity: 'preventable',
    platforms: PC,
    notes: ['Windows and Linux history navigation. macOS uses Cmd+[ and Cmd+Left.'],
  },
  {
    binding: 'Alt+ArrowRight',
    action: 'Forward',
    severity: 'preventable',
    platforms: PC,
    notes: ['See Alt+Left.'],
  },
  {
    binding: 'Mod+BracketLeft',
    action: 'Back',
    severity: 'preventable',
    platforms: ['mac'],
    notes: ['macOS Safari and Chrome. Cmd+] goes forward.'],
  },
  {
    binding: 'Mod+KeyS',
    action: 'Save page',
    severity: 'preventable',
    platforms: ALL,
    notes: ['Wren overrides it for "Save". The page may cancel it in every major browser.'],
  },
  {
    binding: 'Mod+KeyP',
    action: 'Print',
    severity: 'preventable',
    platforms: ALL,
    notes: ['The page may cancel it.'],
  },
  {
    binding: 'Mod+KeyO',
    action: 'Open file',
    severity: 'preventable',
    platforms: ALL,
    notes: ['Wren overrides it for "Open". The page may cancel it.'],
  },
  {
    binding: 'Mod+KeyF',
    action: 'Find in page',
    severity: 'preventable',
    platforms: ALL,
    notes: ['The page may cancel it.'],
  },
  {
    binding: 'Mod+KeyD',
    action: 'Bookmark page',
    severity: 'preventable',
    platforms: ALL,
    notes: ['The page may cancel it (Firefox and Chrome).'],
  },
  {
    binding: 'Mod+KeyG',
    action: 'Find next',
    severity: 'preventable',
    platforms: ALL,
    notes: ['The page may cancel it.'],
  },
  {
    binding: 'Mod+KeyH',
    action: 'History (Windows, Linux) / hide app (macOS)',
    severity: 'preventable',
    platforms: ALL,
    notes: ['macOS: Cmd+H hides the whole app and cannot be cancelled.'],
  },
  {
    binding: 'Mod+KeyU',
    action: 'View source',
    severity: 'preventable',
    platforms: PC,
    notes: ['Chrome, Edge and Firefox on Windows and Linux.'],
  },
  {
    binding: 'Mod+Digit0',
    action: 'Reset browser zoom',
    severity: 'preventable',
    platforms: ALL,
    notes: [
      'Mod+Plus and Mod+Minus zoom the page. They can be cancelled, but users expect them to work.',
    ],
  },
  ...(['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const).map(
    (d): ReservedShortcut => ({
      binding: `Mod+Digit${d}`,
      action: d === '9' ? 'Last tab' : `Tab ${d}`,
      severity: 'blocked',
      platforms: ALL,
      notes: [
        'Chrome, Edge and Firefox switch tabs before the page sees the key (Alt+digit on Firefox for Linux).',
      ],
    }),
  ),
  {
    binding: 'Alt+F4',
    action: 'Close the window',
    severity: 'blocked',
    platforms: ['win'],
    notes: ['Windows handles it; the page never sees it.'],
  },
  {
    binding: 'Mod+KeyM',
    action: 'Minimise window',
    severity: 'blocked',
    platforms: ['mac'],
    notes: ['macOS handles Cmd+M.'],
  },
];

/** Reserved entries that apply on `platform` (all, for `other`). */
export function reservedFor(platform: Platform = detectPlatform()): readonly ReservedShortcut[] {
  if (platform === 'other') return BROWSER_RESERVED;
  return BROWSER_RESERVED.filter((r) => r.platforms.includes(platform));
}

/** The browser-reserved entry for a binding id on `platform`, if any. */
export function findReserved(
  bindingId: string,
  platform: Platform = detectPlatform(),
): ReservedShortcut | undefined {
  const id = normalizeBindingId(bindingId);
  return id ? reservedFor(platform).find((r) => r.binding === id) : undefined;
}

/* ------------------------------------------------------------------------- commands */

/** Where a command is available. `global` is available in every context. */
export type KeymapContext = 'global' | 'model' | 'sketch';

export interface KeymapCommand {
  id: string;
  label: string;
  /** Group heading in the editor and the overlay ("Modeling", "Sketch", "View"). */
  group: string;
  context: KeymapContext;
  /** Default bindings (canonical ids). */
  defaults: readonly string[];
  /** Not rebindable (Esc, Space-repeat rules...): listed but locked. */
  locked?: boolean;
}

/** User overrides: command id -> bindings. An empty array unbinds a command. */
export type KeymapOverrides = Readonly<Record<string, readonly string[]>>;

export type ResolvedKeymap = Readonly<Record<string, readonly string[]>>;

/** Defaults with the user's overrides applied (invalid binding strings dropped). */
export function resolveKeymap(
  commands: readonly KeymapCommand[],
  overrides: KeymapOverrides = {},
): ResolvedKeymap {
  const out: Record<string, readonly string[]> = {};
  for (const c of commands) {
    const raw = !c.locked && overrides[c.id] ? (overrides[c.id] as readonly string[]) : c.defaults;
    const seen = new Set<string>();
    for (const b of raw) {
      const n = normalizeBindingId(b);
      if (n) seen.add(n);
    }
    out[c.id] = [...seen];
  }
  return out;
}

const contextsOverlap = (a: KeymapContext, b: KeymapContext) =>
  a === b || a === 'global' || b === 'global';

/**
 * The command a binding runs in the active contexts (`['sketch', 'global']` while sketching).
 * A more specific context wins over `global`; among equals the first command in list order.
 */
export function matchCommand(
  commands: readonly KeymapCommand[],
  resolved: ResolvedKeymap,
  bindingId: string,
  active: readonly KeymapContext[],
): KeymapCommand | undefined {
  const hits = commands.filter(
    (c) => active.includes(c.context) && resolved[c.id]?.includes(bindingId),
  );
  return hits.find((c) => c.context !== 'global') ?? hits[0];
}

export interface BindingConflicts {
  /** Other commands that already use the binding in an overlapping context. */
  commands: KeymapCommand[];
  /** The browser or OS shortcut it collides with. */
  reserved?: ReservedShortcut;
}

/** Everything `bindingId` collides with if it were added to command `forId`. */
export function findConflicts(
  commands: readonly KeymapCommand[],
  resolved: ResolvedKeymap,
  forId: string,
  bindingId: string,
  platform: Platform = detectPlatform(),
): BindingConflicts {
  const me = commands.find((c) => c.id === forId);
  const id = normalizeBindingId(bindingId) ?? bindingId;
  const others = commands.filter(
    (c) =>
      c.id !== forId &&
      me &&
      contextsOverlap(c.context, me.context) &&
      resolved[c.id]?.includes(id),
  );
  const reserved = findReserved(id, platform);
  return reserved ? { commands: others, reserved } : { commands: others };
}

/** True when the focused element takes typed text, so single-key shortcuts must not fire. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''));
}
