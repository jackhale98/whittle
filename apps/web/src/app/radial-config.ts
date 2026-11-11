/**
 * Radial menu customisation (PLAN M3.8, ADR-085): per-context rings chosen from the command
 * registry, the flick window and "Draw after a delay". Pure apart from the small localStorage
 * reader/writer. Stored per device under `wren.radial`, beside the keymap, schema-versioned.
 * Lazy: only the radial layer and the settings panel import it, never the initial route.
 *
 * A context with no stored ring uses today's contents (`radial.ts`) unchanged, so users who never
 * customise see no difference. A stored ring has fixed positions: an item that does not apply to
 * the selection is disabled, never removed.
 */

import type { PickKind } from '@wren-cad/contracts';
import {
  RADIAL_FILL_ORDER,
  type RadialItem,
  sketchCurveTools,
  sketchTools,
  tools,
} from '@wren-cad/ui';
import {
  MAX_RADIAL_ITEMS,
  modelRadialIds,
  RADIAL_ADD_FOLDER,
  type RadialSelection,
  sketchRadialIds,
} from './radial';

export const RADIAL_KEY = 'wren.radial';
export const RADIAL_SCHEMA_VERSION = 1;
export const DEFAULT_FLICK_WINDOW = 250;
export const MAX_FLICK_WINDOW = 400;
export const RING_SIZE = MAX_RADIAL_ITEMS;

export type RadialContext =
  | 'empty'
  | 'face'
  | 'edge'
  | 'vertex'
  | 'body'
  | 'feature'
  | 'sketchIdle'
  | 'sketchSel';

export interface RadialContextInfo {
  id: RadialContext;
  label: string;
  hint: string;
  sketch: boolean;
}

export const RADIAL_CONTEXTS: readonly RadialContextInfo[] = [
  { id: 'empty', label: 'Empty space', hint: 'Right click on nothing.', sketch: false },
  { id: 'face', label: 'Face', hint: 'One or more faces are selected.', sketch: false },
  { id: 'edge', label: 'Edge', hint: 'One or more edges are selected.', sketch: false },
  { id: 'vertex', label: 'Vertex', hint: 'One or more vertices are selected.', sketch: false },
  {
    id: 'body',
    label: 'Body or mixed selection',
    hint: 'A mixed selection (for example an edge and a face).',
    sketch: false,
  },
  {
    id: 'feature',
    label: 'Feature in the tree',
    hint: 'Features are picked in the feature tree and nothing in the view.',
    sketch: false,
  },
  { id: 'sketchIdle', label: 'Sketch, nothing selected', hint: 'While sketching.', sketch: true },
  {
    id: 'sketchSel',
    label: 'Sketch, with a selection',
    hint: 'While sketching, with geometry selected.',
    sketch: true,
  },
];

export type Ring = readonly (string | null)[];

export interface RadialConfig {
  /** Only customised contexts appear. */
  rings: Partial<Record<RadialContext, Ring>>;
  /** ms; 0 = flicks off. */
  flickWindow: number;
  drawAfterDelay: boolean;
}

export const DEFAULT_RADIAL_CONFIG: RadialConfig = {
  rings: {},
  flickWindow: DEFAULT_FLICK_WINDOW,
  drawAfterDelay: false,
};

const pad = (ids: readonly (string | null)[]): (string | null)[] =>
  Array.from({ length: RING_SIZE }, (_, i) => ids[i] ?? null);

/** Today's ring for a context (the representative selection for those with variants). */
export function defaultRing(ctx: RadialContext): Ring {
  switch (ctx) {
    case 'empty':
      return pad(modelRadialIds([]));
    case 'face':
      return pad(modelRadialIds([{ kind: 'face', planar: true }]));
    case 'edge':
      return pad(modelRadialIds([{ kind: 'edge' }]));
    case 'vertex':
      return pad(modelRadialIds([{ kind: 'vertex' }]));
    case 'body':
      return pad(modelRadialIds([{ kind: 'edge' }, { kind: 'face' }]));
    case 'feature':
      return pad(modelRadialIds([], { folderable: true }));
    default:
      return pad(sketchRadialIds());
  }
}

export interface ContextState {
  sketch: boolean;
  sketchSelected?: boolean;
  /** Features picked in the tree. */
  treePicked?: number;
}

/** Which ring applies; null for a selection that has no customisable ring (sketch regions). */
export function contextOf(sel: readonly RadialSelection[], st: ContextState): RadialContext | null {
  if (st.sketch) return st.sketchSelected ? 'sketchSel' : 'sketchIdle';
  if (sel.length === 0) return (st.treePicked ?? 0) > 0 ? 'feature' : 'empty';
  const all = (k: PickKind) => sel.every((s) => s.kind === k);
  if (all('region')) return null;
  if (all('face')) return 'face';
  if (all('edge')) return 'edge';
  if (all('vertex')) return 'vertex';
  return 'body';
}

/** The stored ring that governs a context (the tree context falls back to Empty space). */
export function customRing(cfg: RadialConfig, ctx: RadialContext | null): Ring | null {
  if (!ctx) return null;
  return cfg.rings[ctx] ?? (ctx === 'feature' ? (cfg.rings.empty ?? null) : null);
}

// -------------------------------------------------------------------------------- the registry

const VIEW_IDS = ['fit', 'iso', 'undo', 'redo'] as const;

/** Every command a ring may hold, by mode. Ids only (labels and icons are the layer's). */
export function registryIds(sketch: boolean): string[] {
  if (sketch)
    return [
      ...[...sketchTools, ...sketchCurveTools].map((t) => `sketch:${t.id}`),
      'sketch:finish',
      ...VIEW_IDS,
    ];
  return [...tools.map((t) => t.id as string), 'cut', RADIAL_ADD_FOLDER, ...VIEW_IDS];
}

export interface ApplyState {
  sel: readonly RadialSelection[];
  folderable: boolean;
  sketch: boolean;
}

/** Whether a command can act on the current selection (otherwise its slot shows disabled). */
export function applies(id: string, st: ApplyState): boolean {
  if (st.sketch) return true;
  const { sel } = st;
  const n = sel.length;
  const all = (k: PickKind) => n > 0 && sel.every((s) => s.kind === k);
  const planar = sel.every((s) => s.planar === true);
  switch (id) {
    case 'extrude':
    case 'extrudeCut':
    case 'cut':
    case 'revolve':
    case 'revolveCut':
    case 'sweep':
      return all('region');
    case 'fillet':
    case 'chamfer':
      return all('edge');
    case 'shell':
    case 'draft':
      return all('face');
    case 'pushPull':
      return all('face') && planar;
    case 'hole':
      return n === 1 && all('face') && planar;
    case 'thread':
      return n === 1 && all('face') && !planar;
    case 'sketch':
    case 'section':
      return n === 0 || (n === 1 && all('face') && planar);
    case 'measure':
      return (
        n === 0 ||
        (n <= 2 && sel.every((s) => s.kind === 'face' || s.kind === 'edge' || s.kind === 'vertex'))
      );
    case 'plane':
    case 'axis':
    case 'point':
      return all('vertex');
    case RADIAL_ADD_FOLDER:
      return st.folderable;
    default:
      return true;
  }
}

/** A stored ring as menu items at fixed slots; inapplicable ones disabled, never dropped. */
export function ringToItems(
  ring: Ring,
  st: ApplyState,
  itemFor: (id: string) => RadialItem,
): RadialItem[] {
  const out: RadialItem[] = [];
  ring.forEach((id, i) => {
    const slot = RADIAL_FILL_ORDER[i];
    if (!id || !slot) return;
    out.push({ ...itemFor(id), slot, disabled: !applies(id, st) });
  });
  return out;
}

// ----------------------------------------------------------------------- persistence, migration

export interface Loaded {
  config: RadialConfig;
  /** Command ids that are no longer in the registry (dropped), for the report. */
  dropped: string[];
  /** The data came from a newer version and was ignored. */
  newer?: boolean;
}

const clampMs = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(MAX_FLICK_WINDOW, Math.max(0, Math.round(v)))
    : DEFAULT_FLICK_WINDOW;

/**
 * Validate and migrate stored or imported data. v0 (no `version`): a ring was a plain list of ids
 * filled clockwise with no gaps; v1: seven positions with nulls. Unknown contexts are ignored,
 * unknown command ids dropped and listed, duplicates and surplus entries dropped.
 */
export function parseRadialConfig(raw: unknown): Loaded {
  const none = (): Loaded => ({ config: { ...DEFAULT_RADIAL_CONFIG, rings: {} }, dropped: [] });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return none();
  const o = raw as Record<string, unknown>;
  const version = o.version === undefined ? 0 : o.version;
  if (typeof version !== 'number' || version > RADIAL_SCHEMA_VERSION)
    return { ...none(), newer: true };
  const rings: Partial<Record<RadialContext, Ring>> = {};
  const dropped: string[] = [];
  const src = o.rings && typeof o.rings === 'object' ? (o.rings as Record<string, unknown>) : {};
  for (const info of RADIAL_CONTEXTS) {
    if (!Object.hasOwn(src, info.id)) continue;
    const list = src[info.id];
    if (!Array.isArray(list)) continue;
    const valid = new Set(registryIds(info.sketch));
    const seen = new Set<string>();
    const ring: (string | null)[] = [];
    const keepGaps = version >= 1;
    for (const v of list.slice(0, keepGaps ? RING_SIZE : 64)) {
      let id: string | null = null;
      if (typeof v === 'string') {
        if (!valid.has(v)) {
          if (!dropped.includes(v)) dropped.push(v);
        } else if (!seen.has(v)) {
          seen.add(v);
          id = v;
        }
      }
      if (id !== null || keepGaps) ring.push(id);
    }
    rings[info.id] = pad(ring);
  }
  return {
    config: {
      rings,
      flickWindow: o.flickWindow === undefined ? DEFAULT_FLICK_WINDOW : clampMs(o.flickWindow),
      drawAfterDelay: o.drawAfterDelay === true,
    },
    dropped,
  };
}

export function serializeRadialConfig(cfg: RadialConfig): string {
  return JSON.stringify({
    version: RADIAL_SCHEMA_VERSION,
    rings: cfg.rings,
    flickWindow: cfg.flickWindow,
    drawAfterDelay: cfg.drawAfterDelay,
  });
}

const isDefault = (c: RadialConfig) =>
  Object.keys(c.rings).length === 0 && c.flickWindow === DEFAULT_FLICK_WINDOW && !c.drawAfterDelay;

let cache: Loaded | null = null;

export function loadRadialConfig(): Loaded {
  if (cache) return cache;
  let loaded: Loaded;
  try {
    const s = globalThis.localStorage?.getItem(RADIAL_KEY);
    loaded = parseRadialConfig(s ? JSON.parse(s) : null);
  } catch {
    loaded = parseRadialConfig(null);
  }
  cache = loaded;
  return loaded;
}

export function saveRadialConfig(cfg: RadialConfig): void {
  cache = { config: cfg, dropped: [] };
  try {
    if (isDefault(cfg)) globalThis.localStorage?.removeItem(RADIAL_KEY);
    else globalThis.localStorage?.setItem(RADIAL_KEY, serializeRadialConfig(cfg));
  } catch {
    // Storage may be unavailable (private mode): the setting lasts for the session.
  }
}

/** Tests: forget the in-memory copy. */
export function resetRadialCache(): void {
  cache = null;
}

/** Sets a context's ring; a ring equal to today's default is not stored. */
export function setRing(cfg: RadialConfig, ctx: RadialContext, ring: Ring): RadialConfig {
  const def = defaultRing(ctx);
  const rings = { ...cfg.rings };
  if (ring.length === def.length && ring.every((v, i) => v === def[i])) delete rings[ctx];
  else rings[ctx] = pad(ring);
  return { ...cfg, rings };
}

export function resetRing(cfg: RadialConfig, ctx: RadialContext): RadialConfig {
  const rings = { ...cfg.rings };
  delete rings[ctx];
  return { ...cfg, rings };
}
