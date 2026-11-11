import { describe, expect, it } from 'vitest';
import { chamferFaceName } from './ops-annot';

describe('chamferFaceName', () => {
  it('finds the chamfer face and its feature in an edge name, with balanced brackets', () => {
    const name =
      'edge(F01AAA:side(S01BBB:e(L2))|F01CCC:chamfer(edge(F01DDD:end|F01DDD:side(S01EEE:e(M1)))))';
    expect(chamferFaceName(name)).toEqual({
      featureId: '01CCC',
      face: 'F01CCC:chamfer(edge(F01DDD:end|F01DDD:side(S01EEE:e(M1))))',
    });
  });

  it('is null for an edge no chamfer made', () => {
    expect(chamferFaceName('edge(F01AAA:end|F01AAA:side(S01BBB:e(L2)))')).toBeNull();
    expect(chamferFaceName('F01AAA:fillet(edge(F01AAA:end))')).toBeNull();
    expect(chamferFaceName('F01CCC:chamfer(unclosed')).toBeNull();
  });
});
