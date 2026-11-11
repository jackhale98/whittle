import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Cross-origin isolation headers for dev and `vite preview` (PLAN §8.3). In production the
 * service worker (src/sw.ts) injects the same headers on GitHub Pages; Cloudflare Pages uses
 * public/_headers. `require-corp` everywhere: Safari has no `credentialless` (see sw.ts).
 */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function gitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as {
  version: string;
};

/** GitHub Pages has no rewrites: unknown paths get `404.html`. Make that the app shell. */
function spaFallback404(): Plugin {
  let outDir = 'dist';
  return {
    name: 'whittle:spa-404',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      handler() {
        const index = resolve(outDir, 'index.html');
        if (existsSync(index)) copyFileSync(index, resolve(outDir, '404.html'));
      },
    },
  };
}

/**
 * Publishes the document JSON Schemas (packages/document/schema, `$id`
 * `https://jackhale98.github.io/wren-cad/schema/<file>`) next to the app at `schema/`.
 */
function publishSchemas(): Plugin {
  let outDir = 'dist';
  const src = resolve(import.meta.dirname, '../../packages/document/schema');
  return {
    name: 'whittle:schemas',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      handler() {
        const dest = resolve(outDir, 'schema');
        mkdirSync(dest, { recursive: true });
        for (const f of readdirSync(src))
          if (f.endsWith('.schema.json')) copyFileSync(resolve(src, f), resolve(dest, f));
      },
    },
  };
}

export default defineConfig(({ command }) => {
  // `/wren-cad/` for the GitHub project site; override with WREN_BASE (e.g. `/` for a custom
  // domain or Cloudflare Pages). Dev always serves at `/` unless overridden.
  const base = process.env.WREN_BASE ?? (command === 'build' ? '/wren-cad/' : '/');

  return {
    base,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __GIT_SHA__: JSON.stringify(gitSha()),
    },
    plugins: [
      react(),
      tailwindcss(),
      spaFallback404(),
      publishSchemas(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        // We register in src/platform/sw-register.ts (one-time isolation reload, update event).
        injectRegister: false,
        registerType: 'prompt',
        manifestFilename: 'manifest.webmanifest',
        devOptions: { enabled: false },
        injectManifest: {
          // Precache the app shell only. The kernel (`*.wasm` and its Emscripten glue) is tens of
          // MB: precaching it would block SW install on the first visit and force phone-tier
          // devices to download it eagerly. It is cached at runtime (CacheFirst, versioned
          // cache) the first time the kernel loads. See src/sw.ts.
          globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
          globIgnores: ['404.html', '**/whittle-kernel*', '**/*.wasm', '**/__e2e__/**'],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
          rollupFormat: 'iife',
        },
        manifest: {
          id: base,
          name: 'Wren CAD',
          short_name: 'Wren',
          description: 'Free, open-source, browser-native parametric CAD. Works offline.',
          lang: 'en',
          dir: 'ltr',
          start_url: base,
          scope: base,
          display: 'standalone',
          display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
          orientation: 'any',
          background_color: '#f3f5f8',
          theme_color: '#f3f5f8',
          categories: ['productivity', 'utilities', 'graphics'],
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            {
              src: 'icons/maskable-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: 'icons/maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
            { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          ],
          file_handlers: [
            {
              action: base,
              accept: {
                'application/x-wren': ['.wrencad', '.whittle'],
                'model/step': ['.step', '.stp'],
                'application/step': ['.step', '.stp'],
                'model/iges': ['.igs', '.iges'],
              },
            },
          ],
          launch_handler: { client_mode: ['focus-existing', 'auto'] },
        },
      }),
    ],
    assetsInclude: ['**/*.wasm'],
    build: {
      target: 'es2022',
      sourcemap: false,
      cssCodeSplit: true,
      rolldownOptions: {
        output: {
          // The drawing route (ADR-092) shares a few small modules with the initial route; without
          // this each became its own chunk and the initial route grew by about 0.6 kB gzip.
          codeSplitting: {
            groups: [
              {
                name: 'shared-small',
                test: /packages[\\/](sketch[\\/]src[\\/]references|document[\\/]src[\\/](check|annotation-fields|hole-tables))\.ts$/,
                minShareCount: 2,
              },
            ],
          },
        },
      },
      // Never inline wasm into a data: URI (it must stay a cacheable, streamable asset).
      assetsInlineLimit: (file) => (file.endsWith('.wasm') ? false : undefined),
    },
    // The threaded Emscripten kernel glue spawns ES-module workers.
    worker: { format: 'es' },
    server: { headers: ISOLATION_HEADERS },
    preview: { headers: ISOLATION_HEADERS },
  };
});
