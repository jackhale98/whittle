// Lighthouse CI (non-gating, ci.yml). The base matches the build (CI: `/<repository name>/`,
// ADR-032), so the audit loads the same paths the deployed site serves.
const base = process.env.WREN_BASE ?? '/wren-cad/';

module.exports = {
  ci: {
    collect: {
      url: [`http://127.0.0.1:4812${base}`],
      numberOfRuns: 3,
      startServerCommand: `node scripts/static-serve.mjs --dir dist --base ${base} --port 4812`,
      startServerReadyPattern: '',
      startServerReadyTimeout: 20000,
      settings: {
        chromeFlags: '--no-sandbox --headless=new',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['warn', { minScore: 0.8 }],
        'categories:best-practices': ['warn', { minScore: 0.9 }],
        'categories:accessibility': ['warn', { minScore: 0.9 }],
        'first-contentful-paint': ['warn', { maxNumericValue: 1800 }],
        'total-blocking-time': ['warn', { maxNumericValue: 300 }],
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
};
