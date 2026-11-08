import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type WhittleDoc } from '../src';

describe('contracts', () => {
  it('a minimal document round-trips through JSON unchanged', () => {
    const doc: WhittleDoc = {
      schemaVersion: SCHEMA_VERSION,
      units: { length: 'mm', angle: 'deg' },
      params: [{ id: '01JC0000000000000000000001', name: 'width', expr: '40mm' }],
      parts: [
        {
          id: '01JC0000000000000000000002',
          name: 'Box',
          rollbackIndex: 1,
          features: [
            {
              id: '01JC0000000000000000000003',
              type: 'primitive',
              name: 'Box 1',
              suppressed: false,
              op: 'new',
              shape: 'box',
              dx: 'width',
              dy: '30mm',
              dz: '20mm',
            },
          ],
        },
      ],
      assemblies: [],
      drawings: [],
      meta: {
        name: 'Box',
        created: '2026-11-08T00:00:00Z',
        modified: '2026-11-08T00:00:00Z',
        app: 'whittle/0.0.0',
      },
    };
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});
