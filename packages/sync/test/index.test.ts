import { describe, expect, it } from 'vitest';
import { SYNC_PACKAGE } from '../src';

describe('@whittle/sync', () => {
  it('loads', () => {
    expect(SYNC_PACKAGE).toBe('@whittle/sync');
  });
});
