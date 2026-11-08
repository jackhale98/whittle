/** The demo bracket (and an import feature) validate against the published JSON Schemas. */
import { describe, expect, it } from 'vitest';
import { schemaErrors, schemaIds } from '../../e2e/schema';
import { demoBracket } from './bracket';

describe('published JSON Schemas', () => {
  it('have their Pages $id', () => {
    for (const id of schemaIds())
      expect(id).toMatch(
        /^https:\/\/jackhale98\.github\.io\/whittle\/schema\/whittle-[a-z]+\.schema\.json$/,
      );
  });

  it('the demo bracket validates (document and every project file)', () => {
    expect(schemaErrors(demoBracket())).toEqual([]);
  });

  it('a document with an import feature validates; a broken one does not', () => {
    const doc = demoBracket();
    const part = doc.parts[0];
    if (!part) throw new Error('no part');
    part.features.push({
      id: '01JIMPORT00000000000000000',
      type: 'import',
      name: 'bracket',
      suppressed: false,
      source: {
        path: 'imports/01JIMPORT00000000000000000.step',
        format: 'step',
        sha256: 'ab'.repeat(32),
        fileName: 'bracket.step',
      },
      op: 'new',
    });
    part.rollbackIndex = part.features.length;
    expect(schemaErrors(doc)).toEqual([]);
    const bad = structuredClone(doc);
    (bad.parts[0]?.features[0] as unknown as { type: string }).type = 'sweep';
    expect(schemaErrors(bad).length).toBeGreaterThan(0);
  });
});
