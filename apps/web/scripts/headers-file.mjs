// Parser and matcher for Cloudflare Pages `_headers` files, so the local static server and the
// tests can apply exactly what Cloudflare will. Supports the subset Wren uses: path rules with a
// `*` splat, indented `Name: value` lines, `#` comments. When several rules match one path their
// headers are all applied; a header set by more than one rule is joined with ", " (Cloudflare's
// documented behaviour).

/** @returns {{ pattern: string, headers: [string, string][] }[]} */
export function parseHeadersFile(text) {
  const rules = [];
  let current;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (/^\s/.test(raw)) {
      const line = raw.trim();
      const i = line.indexOf(':');
      if (!current || i < 1) throw new Error(`_headers: unexpected line "${line}"`);
      current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    } else {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
    }
  }
  return rules;
}

function toRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Headers (lower-cased names) Cloudflare would add to a response for `pathname`. */
export function headersFor(rules, pathname) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rule of rules) {
    if (!toRegExp(rule.pattern).test(pathname)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      out[key] = key in out ? `${out[key]}, ${value}` : value;
    }
  }
  return out;
}
