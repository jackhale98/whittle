import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { zipFiles } from '../src/zip';

const enc = new TextEncoder();

describe('zip of export files (every sheet as SVG or DXF)', () => {
  it('holds every file under its name, in order, and is reproducible', () => {
    const files = [
      { name: 'bracket-sheet-1.svg', bytes: enc.encode('<svg/>') },
      { name: 'bracket-details.svg', bytes: enc.encode('<svg>2</svg>') },
    ];
    const a = zipFiles(files);
    const out = unzipSync(a);
    expect(Object.keys(out)).toEqual(['bracket-sheet-1.svg', 'bracket-details.svg']);
    expect(new TextDecoder().decode(out['bracket-details.svg'])).toBe('<svg>2</svg>');
    expect(zipFiles(files)).toEqual(a);
  });
  it('never drops a file whose name repeats', () => {
    const out = unzipSync(
      zipFiles([
        { name: 'a.dxf', bytes: enc.encode('1') },
        { name: 'a.dxf', bytes: enc.encode('2') },
      ]),
    );
    expect(Object.keys(out)).toEqual(['a.dxf', 'a-2.dxf']);
  });
});
