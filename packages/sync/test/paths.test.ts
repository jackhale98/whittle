import { describe, expect, it } from 'vitest';
import { documentPaths, pushRank, syncable, toAbsolute, toRelative } from '../src/paths';

describe('project file rules', () => {
  it('syncs every project file except the .whittle/ cache', () => {
    for (const p of [
      'whittle.project.json',
      'params.json',
      'parts/bracket.part.json',
      'imports/01J.step',
      'releases/rev-a/bracket.pdf',
      'previews/bracket.stl',
      '.whittle-history/versions/01J.json',
      '.whittle-history/snapshots/abc.zip',
      '.whittle-history/refs/heads/main/01J',
      '.whittle-historyx/x',
    ])
      expect(syncable(p), p).toBe(true);
    for (const p of [
      '.whittle/meshes/a.bin',
      '.whittle/thumb.png',
      '.whittle',
      '.git/config',
      'parts/.DS_Store',
      'Thumbs.db',
      'drawings/~$sheet.docx',
      'notes/.~lock.a.odt#',
      '',
      '/abs.json',
      'a/../b.json',
      'dir/',
    ])
      expect(syncable(p), p).toBe(false);
  });

  it('maps project-relative and service paths, case-insensitively where the service is', () => {
    expect(toAbsolute('/CAD/bracket', 'parts/a.json')).toBe('/CAD/bracket/parts/a.json');
    expect(toAbsolute('', 'a.json')).toBe('/a.json');
    expect(toRelative('/CAD/bracket', '/cad/BRACKET/parts/a.json', false)).toBe('parts/a.json');
    expect(toRelative('/CAD/bracket', '/cad/BRACKET/parts/a.json', true)).toBeNull();
    expect(toRelative('/CAD/bracket', '/CAD/bracket2/x.json', false)).toBeNull();
    expect(toRelative('', '/x.json', true)).toBe('x.json');
  });

  it('finds the document’s files from any manifest, and pushes the manifest last', () => {
    const m = new TextEncoder().encode(
      JSON.stringify({
        parts: [{ file: 'parts/a.part.json' }],
        drawings: [{ file: 'drawings/d.drawing.json' }],
      }),
    );
    expect([...documentPaths(m, null, new TextEncoder().encode('not json'))].sort()).toEqual([
      'drawings/d.drawing.json',
      'params.json',
      'parts/a.part.json',
      'whittle.project.json',
    ]);
    const order = ['whittle.project.json', 'parts/a.part.json', 'params.json']
      .map((p) => [p, pushRank(p, false)] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([p]) => p);
    expect(order).toEqual(['parts/a.part.json', 'params.json', 'whittle.project.json']);
    expect(pushRank('parts/a.part.json', true)).toBeGreaterThan(
      pushRank('whittle.project.json', false),
    );
  });
});
