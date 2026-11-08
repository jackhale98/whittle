// SPDX-License-Identifier: GPL-3.0-or-later

/** Minimal tolerant XML event scanner (no DOMParser in workers/Node). Elements + attributes only. */
export interface XmlHandlers {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
}

const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    switch (e) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const cp = e.startsWith('#x')
          ? Number.parseInt(e.slice(2), 16)
          : Number.parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      }
    }
  });
}

/** Local part of a possibly prefixed name (`p:path` -> `path`). */
export function local(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/** Scan `xml`; element and attribute names are returned without namespace prefixes. */
export function scanXml(xml: string, h: XmlHandlers): void {
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(xml); m; m = TOKEN.exec(xml)) {
    const name = m[2];
    if (name === undefined) continue; // comment / PI / CDATA / doctype
    if (m[1] === '/') {
      h.close(local(name));
      continue;
    }
    const attrs: Record<string, string> = {};
    const raw = m[3] ?? '';
    ATTR.lastIndex = 0;
    for (let a = ATTR.exec(raw); a; a = ATTR.exec(raw)) {
      attrs[local(a[1] as string)] = unescapeXml((a[2] ?? a[3]) as string);
    }
    const selfClosing = m[4] === '/';
    h.open(local(name), attrs, selfClosing);
    if (selfClosing) h.close(local(name));
  }
}
