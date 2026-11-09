// SPDX-License-Identifier: GPL-3.0-or-later
import type { JsonPatchOp } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { applyPatch, diff, getAt, jsonEqual, PatchError, parsePointer, pointerOf } from '../src';

const base = () => ({ a: 1, list: [1, 2, 3], nested: { x: { y: 'z' } }, 'a/b': 1, 'c~d': 2 });

/** Applies then inverts and asserts the original comes back. */
function roundTrip(ops: JsonPatchOp[], start: unknown = base()) {
  const before = structuredClone(start);
  const r = applyPatch(start, ops);
  expect(start).toEqual(before); // input untouched
  const back = applyPatch(r.doc, r.inverse);
  expect(back.doc).toEqual(before);
  // and the inverse of the inverse re-applies the change
  expect(applyPatch(back.doc, back.inverse).doc).toEqual(r.doc);
  return r.doc as ReturnType<typeof base>;
}

describe('JSON pointer', () => {
  it('parses and escapes (RFC 6901)', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/a~1b/c~0d/0')).toEqual(['a/b', 'c~d', '0']);
    expect(pointerOf('a/b', 'c~d', 3)).toBe('/a~1b/c~0d/3');
    expect(() => parsePointer('a')).toThrow(PatchError);
    expect(() => parsePointer('/__proto__/x')).toThrow(PatchError);
  });
  it('reads values', () => {
    expect(getAt(base(), '/nested/x/y')).toBe('z');
    expect(getAt(base(), '/a~1b')).toBe(1);
    expect(() => getAt(base(), '/nope')).toThrow(PatchError);
    expect(() => getAt(base(), '/list/9')).toThrow(PatchError);
  });
});

describe('applyPatch', () => {
  it('add / replace / remove on objects', () => {
    const d = roundTrip([
      { op: 'add', path: '/b', value: { k: [1] } },
      { op: 'replace', path: '/a', value: 2 },
      { op: 'remove', path: '/nested/x' },
    ]);
    expect(d).toMatchObject({ a: 2, b: { k: [1] }, nested: {} });
  });

  it('add to an existing key replaces and inverts to the old value', () => {
    const d = roundTrip([{ op: 'add', path: '/a', value: 'new' }]);
    expect(d.a).toBe('new');
  });

  it('array insert, append (-), remove', () => {
    expect(roundTrip([{ op: 'add', path: '/list/1', value: 9 }]).list).toEqual([1, 9, 2, 3]);
    expect(roundTrip([{ op: 'add', path: '/list/-', value: 9 }]).list).toEqual([1, 2, 3, 9]);
    expect(roundTrip([{ op: 'add', path: '/list/3', value: 9 }]).list).toEqual([1, 2, 3, 9]);
    expect(roundTrip([{ op: 'remove', path: '/list/0' }]).list).toEqual([2, 3]);
    expect(roundTrip([{ op: 'replace', path: '/list/2', value: 'x' }]).list).toEqual([1, 2, 'x']);
  });

  it('move and copy', () => {
    expect(roundTrip([{ op: 'move', from: '/list/0', path: '/list/2' }]).list).toEqual([2, 3, 1]);
    expect(roundTrip([{ op: 'move', from: '/list/2', path: '/list/0' }]).list).toEqual([3, 1, 2]);
    const m = roundTrip([{ op: 'move', from: '/nested/x', path: '/moved' }]);
    expect(m).toMatchObject({ moved: { y: 'z' }, nested: {} });
    const c = roundTrip([{ op: 'copy', from: '/nested', path: '/dup' }]) as unknown as {
      dup: unknown;
    };
    expect(c.dup).toEqual({ x: { y: 'z' } });
    expect(roundTrip([{ op: 'move', from: '/a', path: '/a' }]).a).toBe(1);
  });

  it('copies are deep (no aliasing)', () => {
    const r = applyPatch(base(), [{ op: 'copy', from: '/nested', path: '/dup' }]);
    const doc = r.doc as unknown as { nested: object; dup: object };
    expect(doc.dup).not.toBe(doc.nested);
  });

  it('replaces the root', () => {
    const r = applyPatch(base(), [{ op: 'replace', path: '', value: { fresh: true } }]);
    expect(r.doc).toEqual({ fresh: true });
    expect(applyPatch(r.doc, r.inverse).doc).toEqual(base());
  });

  it('test passes or aborts the whole patch', () => {
    expect(applyPatch(base(), [{ op: 'test', path: '/a', value: 1 }]).doc).toEqual(base());
    expect(() =>
      applyPatch(base(), [
        { op: 'replace', path: '/a', value: 5 },
        { op: 'test', path: '/a', value: 1 },
      ]),
    ).toThrow(/Test failed/);
  });

  it('shares untouched subtrees (structural sharing)', () => {
    const start = base();
    const r = applyPatch(start, [{ op: 'replace', path: '/a', value: 2 }]);
    const out = r.doc as ReturnType<typeof base>;
    expect(out.nested).toBe(start.nested);
    expect(out.list).toBe(start.list);
    expect(out).not.toBe(start);
  });

  it('does not alias values passed in ops', () => {
    const value = { q: 1 };
    const r = applyPatch({} as Record<string, unknown>, [{ op: 'add', path: '/v', value }]);
    value.q = 2;
    expect((r.doc.v as { q: number }).q).toBe(1);
  });

  it('rejects invalid operations with PatchError', () => {
    const bad: JsonPatchOp[] = [
      { op: 'remove', path: '/missing' },
      { op: 'replace', path: '/missing', value: 1 },
      { op: 'add', path: '/missing/deep', value: 1 },
      { op: 'add', path: '/list/9', value: 1 },
      { op: 'add', path: '/list/x', value: 1 },
      { op: 'remove', path: '/list/3' },
      { op: 'remove', path: '/list/-' },
      { op: 'move', from: '/nested', path: '/nested/x/inner' },
      { op: 'copy', from: '/missing', path: '/z' },
    ];
    for (const op of bad) expect(() => applyPatch(base(), [op])).toThrow(PatchError);
  });

  it('refuses prototype pollution', () => {
    expect(() => applyPatch({}, [{ op: 'add', path: '/__proto__/polluted', value: 1 }])).toThrow(
      PatchError,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('inverse of a long mixed patch restores exactly', () => {
    const ops: JsonPatchOp[] = [
      { op: 'add', path: '/list/-', value: 4 },
      { op: 'move', from: '/list/0', path: '/list/3' },
      { op: 'replace', path: '/nested/x/y', value: 'w' },
      { op: 'copy', from: '/nested', path: '/n2' },
      { op: 'remove', path: '/a' },
      { op: 'add', path: '/a', value: [1, { z: 1 }] },
    ];
    roundTrip(ops);
  });
});

describe('diff', () => {
  it('produces minimal, correct patches', () => {
    const a = { f: { r: '2mm', n: 'x', arr: [1, { q: 1 }, 3] }, gone: 1 };
    const b = { f: { r: '3mm', n: 'x', arr: [1, { q: 2 }, 3], added: true } };
    const ops = diff(a, b);
    expect(ops).toEqual([
      { op: 'replace', path: '/f/r', value: '3mm' },
      { op: 'replace', path: '/f/arr/1/q', value: 2 },
      { op: 'add', path: '/f/added', value: true },
      { op: 'remove', path: '/gone' },
    ]);
    expect(applyPatch(a, ops).doc).toEqual(b);
  });
  it('replaces arrays of different length wholesale; honours base pointers', () => {
    expect(diff({ l: [1, 2] }, { l: [1] })).toEqual([{ op: 'replace', path: '/l', value: [1] }]);
    expect(diff({ x: 1 }, { x: 2 }, '/base')).toEqual([
      { op: 'replace', path: '/base/x', value: 2 },
    ]);
    expect(diff(1, 1)).toEqual([]);
    expect(diff({ 'a/b': 1 }, { 'a/b': 2 })).toEqual([{ op: 'replace', path: '/a~1b', value: 2 }]);
  });
  it('jsonEqual compares structurally', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});
