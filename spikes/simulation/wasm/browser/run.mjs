// Spike S0: mesh in a browser worker (headless Chromium via the repo's Playwright). Serves
// spikes/simulation/ with COOP/COEP (so the threaded variant can share memory) and prints stats.
//   node spikes/simulation/wasm/browser/run.mjs <part> <size> [single|multi] [algo3d]
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const [part = 'bracket', size = '4', variant = 'single', algo3d = '1'] = process.argv.slice(2);

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const file = path === '/' ? join(root, 'wasm/browser/index.html') : normalize(join(root, path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route('**/*', (r) => r.continue());
await page.goto(`http://127.0.0.1:${port}/`);
const result = await page.evaluate(
  (a) =>
    new Promise((resolve) => {
      const w = new Worker('/wasm/browser/worker.js', { type: 'module' });
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => resolve({ error: e.message });
      w.postMessage(a);
    }),
  { part, size: Number(size), variant, algo3d: Number(algo3d) },
);
console.log(JSON.stringify({ browser: `chromium ${browser.version()}`, ...result }));
await browser.close();
server.close();
