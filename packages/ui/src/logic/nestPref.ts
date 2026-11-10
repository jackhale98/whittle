import { readStored, writeStored } from './persist';

export const NEST_SKETCHES_KEY = 'whittle.nestSketches';

/**
 * The persisted "nest sketches" view setting (per user, localStorage; default on). It lives apart
 * from `FeatureTree` so the app can read it without pulling the tree into the initial route.
 */
export function readNestSketches(): boolean {
  return readStored(NEST_SKETCHES_KEY) !== 'flat';
}
export function writeNestSketches(nest: boolean): void {
  writeStored(NEST_SKETCHES_KEY, nest ? 'nested' : 'flat');
}
