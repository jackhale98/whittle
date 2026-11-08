// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Branch and release names: validation, and how they appear in paths and git refs. Names are
 * free text for people ("Try a thinner wall", "Rev A"); paths and refs need safe forms.
 */

/** Human-readable problem with a branch or release name, or `undefined` when it's fine. */
export function nameProblem(name: string, what: 'branch' | 'release'): string | undefined {
  const noun = what === 'branch' ? 'A branch' : 'A release';
  if (name.trim() === '') return `${noun} needs a name`;
  if (name !== name.trim()) return `${noun} name can’t start or end with a space`;
  if (name.length > 100) return `${noun} name can be at most 100 characters`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(name)) return `${noun} name can’t contain control characters`;
  return undefined;
}

/**
 * One path segment for a name: `A-Z a-z 0-9 _ -` are kept, every other UTF-8 byte is `%XX`
 * (uppercase hex). Safe on every file service (no `.`, `/`, `*`, `:` or spaces), reversible.
 */
export function encodeName(name: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(name)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9_-]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function decodeName(segment: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] === '%') {
      bytes.push(Number.parseInt(segment.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(segment.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * A git ref name for a branch or tag (git-check-ref-format): spaces become `-`, characters git
 * forbids are dropped, and the result never starts with `-` or `.`, nor contains `..` or `@{`.
 * Branch names that are already valid stay as typed (`feature/thin-wall`).
 */
export function gitRefName(name: string): string {
  let s = name
    .trim()
    .replace(/\s+/g, '-')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: git forbids control characters
    .replace(/[\u0000-\u001f\u007f~^:?*[\\]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/@\{/g, '@')
    .replace(/\/{2,}/g, '/')
    .split('/')
    .map((part) =>
      part
        .replace(/^\.+/, '')
        .replace(/\.lock$/i, '')
        .replace(/\.+$/, ''),
    )
    .filter(Boolean)
    .join('/');
  s = s.replace(/^-+/, '');
  if (s === '' || s === '@') s = 'ref';
  return s;
}
