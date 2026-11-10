// Spike S0: raw / gzip -9 / brotli q11 sizes of the Wasm mesher artefacts.
//   node spikes/simulation/wasm/size.mjs [single|multi]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const variant = process.argv[2] ?? 'single';
const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'build', variant, 'out');
const mib = (n) => `${(n / 2 ** 20).toFixed(2)} MiB`;
for (const f of readdirSync(dir).filter((x) => /\.(wasm|js)$/.test(x))) {
  const b = readFileSync(join(dir, f));
  const gz = gzipSync(b, { level: 9 }).length;
  const br = brotliCompressSync(b, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: b.length },
  }).length;
  console.log(JSON.stringify({ file: f, raw: b.length, gzip: gz, brotli: br }), mib(b.length), mib(gz), mib(br));
}
