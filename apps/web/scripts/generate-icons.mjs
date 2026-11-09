// Regenerates the PNG icons in public/icons from the SVG art below.
// Not part of the build (PNGs are committed). Usage, from apps/web:
//   mkdir /tmp/icons && cd /tmp/icons && npm i sharp@0.35.5 && cp <repo>/apps/web/scripts/generate-icons.mjs . \
//     && OUT_DIR=<repo>/apps/web/public/icons node generate-icons.mjs
// (sharp is deliberately not a project dependency: it has a native postinstall.)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out =
  process.env.OUT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(out, { recursive: true });

// Isometric cube (three azure tints) with a white "W" monogram across its faces.
const cube = `
  <polygon points="256,106 386,181 256,256 126,181" fill="#6cb6ff"/>
  <polygon points="126,181 256,256 256,406 126,331" fill="#2f8cf0"/>
  <polygon points="386,181 256,256 256,406 386,331" fill="#0a5fc4"/>
  <path d="M176 196 L216 316 L256 236 L296 316 L336 196" fill="none" stroke="#fff"
        stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>`;

const svg = (background) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Wren</title>${background}${cube}</svg>`;

const rounded = svg('<rect width="512" height="512" rx="112" fill="#1c2530"/>');
const bleed = svg('<rect width="512" height="512" fill="#1c2530"/>');

writeFileSync(resolve(out, 'icon.svg'), `${rounded}\n`);

const targets = [
  ['icon-192.png', rounded, 192],
  ['icon-512.png', rounded, 512],
  ['maskable-192.png', bleed, 192],
  ['maskable-512.png', bleed, 512],
  ['apple-touch-icon.png', bleed, 180],
];
for (const [name, source, size] of targets) {
  await sharp(Buffer.from(source))
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(resolve(out, name));
}
console.log('icons written to', out);
