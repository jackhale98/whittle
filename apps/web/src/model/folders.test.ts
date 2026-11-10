import { describe, expect, it } from 'vitest';
import {
  type KeyValueStore,
  nextFolderName,
  readCollapsedFolders,
  writeCollapsedFolders,
} from './folders';

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
};

describe('nextFolderName', () => {
  it('counts Folder 1, Folder 2, …', () => {
    expect(nextFolderName([])).toBe('Folder 1');
    expect(nextFolderName([{ name: 'Folder 1' }])).toBe('Folder 2');
    expect(nextFolderName([{ name: 'Folder 1' }, { name: 'Folder 2' }])).toBe('Folder 3');
  });
  it('takes the lowest free number and ignores renamed folders', () => {
    expect(nextFolderName([{ name: 'Mounting' }])).toBe('Folder 1');
    expect(nextFolderName([{ name: 'Folder 2' }])).toBe('Folder 1');
  });
});

describe('collapsed folders (per document UI state)', () => {
  it('round-trips per document id', () => {
    const store = memory();
    writeCollapsedFolders('doc-a', ['f1', 'f2'], store);
    writeCollapsedFolders('doc-b', ['g1'], store);
    expect(readCollapsedFolders('doc-a', store)).toEqual(['f1', 'f2']);
    expect(readCollapsedFolders('doc-b', store)).toEqual(['g1']);
    expect(readCollapsedFolders('doc-c', store)).toEqual([]);
  });
  it('tolerates junk and unavailable storage', () => {
    const store = memory();
    store.setItem('wren.collapsedFolders.d', '{not json');
    expect(readCollapsedFolders('d', store)).toEqual([]);
    store.setItem('wren.collapsedFolders.d', '[1,"a",null]');
    expect(readCollapsedFolders('d', store)).toEqual(['a']);
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(readCollapsedFolders('d', broken)).toEqual([]);
    expect(() => writeCollapsedFolders('d', ['x'], broken)).not.toThrow();
    expect(readCollapsedFolders('d', null)).toEqual([]);
  });
});
