import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISOLATION_HEADERS } from '../src/platform/isolation-headers.ts';
import {
  checkDist,
  MIB,
  WORKER_NAME,
  wranglerConfig,
  writeWorkerBundle,
} from './cloudflare-dist.mjs';
import { headersFor, parseHeadersFile } from './headers-file.mjs';

const manifest = JSON.stringify({ start_url: '/', scope: '/', id: '/' });

function fixture(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wren-cf-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  writeFileSync(join(dir, '_headers'), '/*\n  X-A: 1\n');
  writeFileSync(join(dir, 'manifest.webmanifest'), opts.manifest ?? manifest);
  mkdirSync(join(dir, 'assets'));
  if (opts.big) writeFileSync(join(dir, 'assets', 'big.wasm'), Buffer.alloc(opts.big));
  return dir;
}

describe('checkDist', () => {
  it('accepts a root-base build with the kernel under the limit', () => {
    expect(checkDist(fixture({ big: 22 * MIB }))).toEqual([]);
  });
  it('fails a file over 25 MiB and names it', () => {
    const problems = checkDist(fixture({ big: 25 * MIB + 1 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('assets/big.wasm');
  });
  it('accepts exactly 25 MiB', () => {
    expect(checkDist(fixture({ big: 25 * MIB }))).toEqual([]);
  });
  it('fails a manifest built for the GitHub Pages base', () => {
    const bad = JSON.stringify({ start_url: '/wren-cad/', scope: '/wren-cad/', id: '/wren-cad/' });
    expect(checkDist(fixture({ manifest: bad }))).toHaveLength(3);
  });
});

describe('public/_headers (Cloudflare Pages)', () => {
  const rules = parseHeadersFile(
    readFileSync(resolve(import.meta.dirname, '../public/_headers'), 'utf8'),
  );
  const at = (path) => headersFor(rules, path);

  it('sends the same isolation policies as the service worker, on every path', () => {
    for (const path of ['/', '/index.html', '/assets/a-1.js', '/some/deep/link']) {
      for (const [name, value] of Object.entries(ISOLATION_HEADERS))
        expect(at(path)[name.toLowerCase()]).toBe(value);
    }
  });

  it('revalidates the shell and caches hashed assets forever, with no merged duplicates', () => {
    for (const path of ['/', '/index.html', '/sw.js', '/manifest.webmanifest'])
      expect(at(path)['cache-control']).toBe('no-cache');
    const kernel = at('/assets/whittle-kernel-AbC123.wasm');
    expect(kernel['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(kernel['content-type']).toBe('application/wasm');
  });
});

describe('_headers parsing', () => {
  const rules = parseHeadersFile(
    '# c\n/*\n  Cross-Origin-Opener-Policy: same-origin\n/assets/*\n  Cache-Control: immutable\n/index.html\n  Cache-Control: no-cache\n',
  );
  it('merges every matching rule', () => {
    expect(headersFor(rules, '/assets/a.js')).toEqual({
      'cross-origin-opener-policy': 'same-origin',
      'cache-control': 'immutable',
    });
    expect(headersFor(rules, '/index.html')['cache-control']).toBe('no-cache');
    expect(headersFor(rules, '/other')['cache-control']).toBeUndefined();
  });
});

describe('Workers static-assets bundle (ADR-082 amendment)', () => {
  it('puts the site under public/ and an assets-only wrangler.jsonc beside it', () => {
    const dist = fixture();
    const out = join(mkdtempSync(join(tmpdir(), 'wren-cfw-')), 'bundle');
    writeWorkerBundle(dist, out, 'wren-cad');
    expect(existsSync(join(out, 'public', 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'public', '_headers'))).toBe(true);
    const text = readFileSync(join(out, 'wrangler.jsonc'), 'utf8');
    const config = JSON.parse(text.slice(text.indexOf('{')));
    expect(config).toEqual({
      name: 'wren-cad',
      compatibility_date: '2025-09-01',
      assets: { directory: './public', not_found_handling: 'single-page-application' },
    });
    expect(config.main).toBeUndefined(); // assets only: no Worker script
  });

  it('refuses names Cloudflare would reject (and anything that could break the JSON)', () => {
    for (const bad of ['', 'Wren', 'wren_cad', '-wren', 'wren-', 'a"b', 'x'.repeat(64)])
      expect(() => wranglerConfig(bad)).toThrow(/invalid Cloudflare Worker name/);
    for (const good of ['wren-cad', 'wren', 'w1-2']) expect(WORKER_NAME.test(good)).toBe(true);
  });
});
