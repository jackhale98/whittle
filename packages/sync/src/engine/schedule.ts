// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/sync/schedule.ts.
/**
 * How long to wait before checking a project for remote changes again. Checks start at the
 * service's own pace and stretch out while nothing changes (or while the service can't be
 * reached), so an idle app open on a tablet costs little. Any change, edit or return to the app
 * starts over. With Data Saver on, checks are rarer still; edits still upload promptly.
 */

const MINUTE = 60_000;
/** The longest wait between checks normally… */
export const MAX_WAIT = 5 * MINUTE;
/** …and when the device asks to save data. */
export const SAVE_DATA_WAIT = 10 * MINUTE;
export const SAVE_DATA_MAX_WAIT = 15 * MINUTE;

export interface CheckPace {
  /** The service's usual interval (e.g. 1 minute for Dropbox). */
  base: number;
  /** Checks in a row that found nothing new, or failed. */
  quiet: number;
  /** The device or browser asked to save data (`navigator.connection.saveData`). */
  saveData: boolean;
}

export function nextCheckDelay({ base, quiet, saveData }: CheckPace): number {
  const start = saveData ? Math.max(base, SAVE_DATA_WAIT) : base;
  const cap = Math.max(start, saveData ? SAVE_DATA_MAX_WAIT : MAX_WAIT);
  return Math.min(cap, start * 2 ** Math.min(quiet, 8));
}

/** Whether the browser reports Data Saver (Chrome on Android; not Safari). */
export function saveDataOn(): boolean {
  const c = (globalThis.navigator as { connection?: { saveData?: boolean } } | undefined)
    ?.connection;
  return !!c?.saveData;
}
