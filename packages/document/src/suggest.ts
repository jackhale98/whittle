// SPDX-License-Identifier: GPL-3.0-or-later
/** "Did you mean …?" support: optimal-string-alignment edit distance (insert, delete, substitute, transpose). */

export function editDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const row = (i: number): number[] => d[i] as number[];
  for (let i = 0; i <= n; i++) row(i)[0] = i;
  for (let j = 0; j <= m; j++) row(0)[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (row(i - 1)[j] as number) + 1,
        (row(i)[j - 1] as number) + 1,
        (row(i - 1)[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (row(i - 2)[j - 2] as number) + 1);
      }
      row(i)[j] = v;
    }
  }
  return row(n)[m] as number;
}

/** Closest candidate within a length-scaled tolerance, or `undefined`. Case-insensitive. */
export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  const lower = name.toLowerCase();
  const max = lower.length <= 2 ? 0 : lower.length <= 4 ? 1 : lower.length <= 8 ? 2 : 3;
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (c === name) continue;
    const dist = editDistance(lower, c.toLowerCase());
    if (dist <= max && (dist < bestD || (dist === bestD && best !== undefined && c < best))) {
      best = c;
      bestD = dist;
    }
  }
  return best;
}
