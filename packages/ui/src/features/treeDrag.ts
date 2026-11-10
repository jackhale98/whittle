import type { Id } from '@wren-cad/contracts';
import type { BlockStep } from '../logic/treeFolders';

/** One place a dragged row can land: a document gap with what it does to folders. */
export interface Slot {
  /** Document gap: the dragged block would sit before feature index `g`. */
  g: number;
  /** Key of the head row the line sits above; null = after the last row. */
  before: string | null;
  /** `into` joins a folder, `out` leaves one, `stay` reorders inside its own folder. */
  kind: 'top' | 'into' | 'stay' | 'out';
  folderId?: Id;
  /** For `out`: the folder it lands inside and joins (a move from one folder into another). */
  joinsId?: Id;
  steps?: BlockStep[];
  toIndex?: number;
  /** Pixel y of the line, measured when the drag starts. */
  y: number;
}

export interface DragState {
  kind: 'feature' | 'folder';
  key: string;
  id: Id;
  dy: number;
  at: number;
  slots: Slot[];
  slot: number | null;
}
