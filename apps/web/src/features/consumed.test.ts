import type { EntityRef, Feature } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { consumedSketchRefs } from './factories';

const ref = (n: string): EntityRef => ({ name: n, kind: 'region' });
const base = { id: 'F', name: 'F', suppressed: false };

describe('consumedSketchRefs: every consuming feature hides its sketch', () => {
  const cases: [string, Feature, string[]][] = [
    [
      'extrude',
      {
        ...base,
        type: 'extrude',
        profile: [ref('S1:r')],
        direction: 'normal',
        end: { kind: 'blind', depth: '1' },
        op: 'new',
      } as Feature,
      ['S1:r'],
    ],
    [
      'extrude cut',
      {
        ...base,
        type: 'extrude',
        profile: [ref('S1:r')],
        direction: 'normal',
        end: { kind: 'blind', depth: '1' },
        op: 'cut',
      } as Feature,
      ['S1:r'],
    ],
    [
      'revolve',
      {
        ...base,
        type: 'revolve',
        profile: [ref('S1:r')],
        axis: ref('S1:axis'),
        angle: '360 deg',
        direction: 'normal',
        op: 'new',
      } as Feature,
      ['S1:r', 'S1:axis'],
    ],
    [
      'revolve cut',
      {
        ...base,
        type: 'revolve',
        profile: [ref('S1:r')],
        axis: ref('S2:axis'),
        angle: '360 deg',
        direction: 'normal',
        op: 'cut',
      } as Feature,
      ['S1:r', 'S2:axis'],
    ],
    [
      'sweep',
      { ...base, type: 'sweep', profile: [ref('S1:r')], path: [ref('S2:p')] } as unknown as Feature,
      ['S1:r', 'S2:p'],
    ],
    [
      'loft',
      { ...base, type: 'loft', sections: [ref('S1:r'), ref('S2:r')] } as unknown as Feature,
      ['S1:r', 'S2:r'],
    ],
    ['hole', { ...base, type: 'hole', points: [ref('S3:p')] } as unknown as Feature, ['S3:p']],
  ];
  for (const [name, f, names] of cases)
    it(name, () => expect(consumedSketchRefs(f).map((r) => r.name)).toEqual(names));
});
