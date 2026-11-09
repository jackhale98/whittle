#!/usr/bin/env node
// Minimal static server that behaves like GitHub Pages for the E2E suite: serves `dist/` under a
// base path with NO COOP/COEP headers (so the service worker's header injection is what makes the
// page cross-origin isolated), `cache-control: max-age=600`, and `404.html` (status 404) for
// unknown paths. Optionally mounts a fixtures directory at `<base>__e2e__/`.
//
// Usage: node scripts/static-serve.mjs [--dir dist] [--base /wren-cad/] [--port 4173]
//                                      [--fixtures e2e/fixtures]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'dist' },
    base: { type: 'string', default: '/wren-cad/' },
    port: { type: 'string', default: '4173' },
    fixtures: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});

const root = resolve(values.dir);
const base = values.base.endsWith('/') ? values.base : `${values.base}/`;
const fixturesRoot = values.fixtures ? resolve(values.fixtures) : undefined;
const fixturesPrefix = `${base}__e2e__/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveFile(dir, relative) {
  const target = normalize(join(dir, relative));
  if (target !== dir && !target.startsWith(dir + sep)) return undefined;
  if (!existsSync(target)) return undefined;
  const stat = statSync(target);
  if (stat.isDirectory()) {
    const index = join(target, 'index.html');
    return existsSync(index) ? index : undefined;
  }
  return target;
}

function send(res, status, file) {
  res.writeHead(status, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'max-age=600',
    // Deliberately no cross-origin-* headers: this is what GitHub Pages does.
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/') {
    res.writeHead(302, { location: base });
    res.end();
    return;
  }
  if (fixturesRoot && pathname.startsWith(fixturesPrefix)) {
    const file = resolveFile(fixturesRoot, pathname.slice(fixturesPrefix.length));
    if (file) return send(res, 200, file);
  } else if (pathname.startsWith(base)) {
    const file = resolveFile(root, pathname.slice(base.length));
    if (file) return send(res, 200, file);
    const notFound = join(root, '404.html');
    if (existsSync(notFound)) return send(res, 404, notFound);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(Number(values.port), values.host, () => {
  console.log(`static-serve: http://${values.host}:${values.port}${base} -> ${root}`);
});
