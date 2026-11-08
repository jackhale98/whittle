import { describe, expect, it } from 'vitest';
import { defaultFormatValue, formatDensity, prettyUnits } from '../src/format';
import { withArticle } from '../src/inspector/PickField';

describe('display formatting', () => {
  it('densities read 2.70 g/cm³ (two decimals, superscript)', () => {
    expect(formatDensity(2.7e-6)).toBe('2.70 g/cm³');
    expect(defaultFormatValue(7.85e-6, [-3, 1, 0, 0])).toBe('7.85 g/cm³');
    expect(prettyUnits('2.70 g/cm^3')).toBe('2.70 g/cm³');
    expect(prettyUnits('2700 kg/m^3')).toBe('2700 kg/m³');
    expect(prettyUnits('width^2')).toBe('width²');
  });

  it('uses a/an by the next word', () => {
    expect(withArticle('edge')).toBe('an edge');
    expect(withArticle('axis or edge')).toBe('an axis or edge');
    expect(withArticle('face')).toBe('a face');
    expect(withArticle('sketch region')).toBe('a sketch region');
  });
});
