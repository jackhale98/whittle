/**
 * Names and storage for reference geometry (ADR-093): the small part the initial route needs
 * (selection, highlights, the tree). Drawing and visibility live in `references.ts`, loaded with
 * the viewport.
 */

/** The persistent name of a reference feature (naming.ts): `F<id>:plane|axis|point`. */
export const referenceName = (id: string, kind: 'plane' | 'axis' | 'point'): string =>
  `F${id}:${kind}`;

export const isOriginName = (name: string): boolean => /^origin:(XY|XZ|YZ|X|Y|Z|O)$/.test(name);

/** Is `name` a reference feature or an origin plane / axis / point? */
export const isReferenceName = (name: string): boolean =>
  /^F[^:]+:(plane|axis|point)$/.test(name) || isOriginName(name);

/** Is this reference (a feature's, or an origin one when `originOn`) in the regen result and so drawn? */
export const isDrawnReference = (
  name: string,
  refs: readonly { featureId: string; kind: string }[] | undefined,
  originOn: boolean,
): boolean =>
  (originOn && isOriginName(name)) || !!refs?.some((x) => `F${x.featureId}:${x.kind}` === name);

/** Does the feature carry reference geometry? */
export const isReferenceFeature = (f: { type: string }): boolean =>
  f.type === 'plane' || f.type === 'axis' || f.type === 'point';

const ORIGIN_KEY = 'wren.view.originPlanes';

export function readOriginToggle(): boolean {
  try {
    return globalThis.localStorage?.getItem(ORIGIN_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeOriginToggle(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(ORIGIN_KEY, '1');
    else globalThis.localStorage?.removeItem(ORIGIN_KEY);
  } catch {
    // storage unavailable: the toggle lasts for this session only
  }
}
