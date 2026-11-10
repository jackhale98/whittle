import type { ConfigTarget, ConfiguredValue, Id, Material } from '@wren-cad/contracts';
import type { MaterialLibraryItem } from '../inspector/materials';
import { toMaterial } from '../inspector/materials';
import {
  type CellValue,
  type ConfigColumn,
  configTargetKey,
  DEFAULT_CONFIGURATION_NAME,
  sameCellValue,
} from './model';

/* TSV paste into the configuration table. Pure: no DOM, no React. */

/**
 * Parses tab-separated text (spreadsheet clipboard format): `\t` between cells, `\n` / `\r\n`
 * between rows, double quotes around cells that contain tabs or newlines (`""` = a quote).
 * One trailing newline is dropped. Rows are padded to a rectangle.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else cell += ch;
    i += 1;
  }
  if (cell !== '' || row.length > 0) endRow();
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}

export const transposeGrid = (grid: readonly (readonly string[])[]): string[][] => {
  const w = grid.reduce((m, r) => Math.max(m, r.length), 0);
  return Array.from({ length: w }, (_, c) => grid.map((r) => r[c] ?? ''));
};

/** Which row an edit targets. */
export type PasteRow =
  | { kind: 'default' }
  | { kind: 'existing'; id: Id }
  | { kind: 'new'; name: string };

export interface PasteEdit {
  row: PasteRow;
  target: ConfigTarget;
  /** Absent = clear the override (the pasted value equals Default's). */
  value?: ConfiguredValue | Material | null;
}

export interface PasteIgnored {
  /** 0-based position in the pasted block (after any transposition). */
  row: number;
  col: number;
  text: string;
  reason: string;
}

export interface PastePlan {
  /** Names of the configurations the paste creates, in order of first appearance. */
  create: string[];
  edits: PasteEdit[];
  /** Cells that were not applied, with the reason: never silently dropped or guessed. */
  ignored: PasteIgnored[];
  /** Whether the first row was read as a header of column labels. */
  header: boolean;
}

export interface PasteRowInfo {
  id: Id;
  name: string;
  overrides: Readonly<Record<string, CellValue>>;
}

export interface PasteInput {
  grid: readonly (readonly string[])[];
  columns: readonly ConfigColumn[];
  rows: readonly PasteRowInfo[];
  defaults: Readonly<Record<string, CellValue>>;
  /** Table shows configurations as columns: the block is read transposed. */
  transposed?: boolean;
  /** Index into `columns` where a block without a header starts (the focused column). Default 0. */
  startColumn?: number;
  materials?: readonly MaterialLibraryItem[];
  /** Returns an error message for an invalid expression (e.g. wraps the evaluator). */
  validateExpr?(expr: string, column: ConfigColumn): string | undefined;
  defaultName?: string;
}

const TRUE = new Set(['true', 'yes', 'y', '1', 'x', 'suppressed', 'suppress', 'on']);
const FALSE = new Set(['false', 'no', 'n', '0', 'active', 'unsuppressed', 'off']);

/** Coerces pasted text for a column, or returns an error string. */
export function coerceCell(
  text: string,
  column: ConfigColumn,
  materials: readonly MaterialLibraryItem[] | undefined,
  validateExpr: PasteInput['validateExpr'],
): { value: ConfiguredValue | Material | null } | { error: string } {
  const t = text.trim();
  switch (column.kind) {
    case 'bool': {
      const k = t.toLowerCase();
      if (TRUE.has(k)) return { value: true };
      if (FALSE.has(k)) return { value: false };
      return { error: 'Expected yes or no' };
    }
    case 'option': {
      const k = t.toLowerCase();
      const o = column.options?.find(
        (x) => x.value.toLowerCase() === k || x.label?.toLowerCase() === k,
      );
      return o ? { value: o.value } : { error: 'Not one of the choices' };
    }
    case 'material': {
      if (/^(none|no material)$/i.test(t)) return { value: null };
      const m = materials?.find((x) => x.name.toLowerCase() === t.toLowerCase());
      return m ? { value: toMaterial(m) } : { error: 'Unknown material' };
    }
    case 'expr': {
      const err = validateExpr?.(t, column);
      return err ? { error: err } : { value: t };
    }
    case 'text':
      return { value: t };
  }
}

/**
 * Turns a pasted block into one batch of edits.
 *
 * Shape: one configuration per row, its name in the first cell, one field per further cell.
 * - Header: when the first row's cells match column labels (case-insensitive) it is a header and
 *   columns are matched by label; labels that match nothing are reported in `ignored`.
 * - No header: cells map to consecutive visible columns starting at `startColumn`.
 * - Names match case-insensitively; `Default` is the Default row; unknown names create configurations.
 * - Empty cells change nothing. A value equal to what the cell already shows is not an edit. A value
 *   equal to Default's clears an override instead of storing a copy (overrides stay sparse).
 * - A transposed table pastes transposed (configurations across the top).
 */
export function planPaste(input: PasteInput): PastePlan {
  const defaultName = input.defaultName ?? DEFAULT_CONFIGURATION_NAME;
  let grid = input.grid.map((r) => [...r]);
  if (input.transposed) grid = transposeGrid(grid);
  const plan: PastePlan = { create: [], edits: [], ignored: [], header: false };
  if (grid.length === 0) return plan;

  const byLabel = new Map(input.columns.map((c, i) => [c.label.trim().toLowerCase(), i]));
  const first = grid[0] ?? [];
  const hits = first.slice(1).filter((c) => byLabel.has(c.trim().toLowerCase())).length;
  const header = hits > 0;
  plan.header = header;

  const colAt: (number | undefined)[] = [];
  const start = Math.max(0, input.startColumn ?? 0);
  const width = first.length;
  for (let c = 1; c < width; c += 1) {
    colAt[c] = header ? byLabel.get((first[c] ?? '').trim().toLowerCase()) : start + c - 1;
    if (header && colAt[c] === undefined && (first[c] ?? '').trim() !== '')
      plan.ignored.push({
        row: 0,
        col: c,
        text: first[c] ?? '',
        reason: 'No column with this name',
      });
  }

  const known = new Map<string, PasteRow>();
  known.set(defaultName.toLowerCase(), { kind: 'default' });
  const infoOf = new Map<string, PasteRowInfo>();
  for (const r of input.rows) {
    known.set(r.name.trim().toLowerCase(), { kind: 'existing', id: r.id });
    infoOf.set(r.id, r);
  }

  for (let r = header ? 1 : 0; r < grid.length; r += 1) {
    const cells = grid[r] ?? [];
    const name = (cells[0] ?? '').trim();
    if (name === '') {
      if (cells.some((c) => c.trim() !== ''))
        plan.ignored.push({
          row: r,
          col: 0,
          text: '',
          reason: 'The row has no configuration name',
        });
      continue;
    }
    const key = name.toLowerCase();
    let row = known.get(key);
    let created = false;
    if (!row) {
      row = { kind: 'new', name };
      known.set(key, row);
      plan.create.push(name);
      created = true;
    }
    for (let c = 1; c < cells.length; c += 1) {
      const text = cells[c] ?? '';
      if (text.trim() === '') continue;
      const ci = colAt[c];
      const column = ci === undefined ? undefined : input.columns[ci];
      if (!column) {
        if (!header) plan.ignored.push({ row: r, col: c, text, reason: 'No column here' });
        continue;
      }
      const res = coerceCell(text, column, input.materials, input.validateExpr);
      if ('error' in res) {
        plan.ignored.push({ row: r, col: c, text, reason: res.error });
        continue;
      }
      const k = configTargetKey(column.target);
      const dflt = input.defaults[k];
      if (row.kind === 'default') {
        if (!sameCellValue(res.value, dflt))
          plan.edits.push({ row, target: column.target, value: res.value });
        continue;
      }
      const info = row.kind === 'existing' ? infoOf.get(row.id) : undefined;
      const overridden = !!info && k in info.overrides;
      const current = overridden ? info?.overrides[k] : dflt;
      if (sameCellValue(res.value, dflt)) {
        if (overridden) plan.edits.push({ row, target: column.target });
      } else if (created || !sameCellValue(res.value, current)) {
        plan.edits.push({ row, target: column.target, value: res.value });
      }
    }
  }
  return plan;
}
