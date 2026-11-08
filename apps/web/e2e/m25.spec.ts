/**
 * M2.5 acceptance (PLAN §12): connections, background sync, versions, compare and merge, end to
 * end in the real app with the real kernel. Providers are fakes on their own origins, so the
 * browser applies its real CORS and COEP rules:
 *
 * - (a) desktop → iPad through a fake Dropbox, visible within 10 s of focusing;
 * - (b) concurrent offline edits: different features merge, the same parameter conflicts and is
 *   resolved in the merge panel with no data loss;
 * - (c) geometric compare in the UI against the analytic removed volume;
 * - (d) a real git smart-HTTP server: commit, push, clone on another device, same volume;
 * - (e) no token readable in plain text from IndexedDB (or Web Storage);
 * - (f) the OAuth redirect round trip: no reload loop, query stripped only after the exchange;
 * - (g) local git repo mode (ADR-029) over an OPFS directory standing in for a picked folder.
 *
 * Run alone: `WHITTLE_E2E_PORT=4391 pnpm --filter @whittle/web exec playwright test m25`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import type { Command, WhittleDoc } from '@whittle/contracts';
import { fid, pocketDoc } from './fixtures';
import { app, boot } from './helpers';
import { dropboxOverrides, type FakeDropbox, startFakeDropbox } from './support/fake-dropbox';
import { type GitServer, startGitServer } from './support/git-server';

test.describe.configure({ timeout: 240_000 });

interface SyncState {
  kind: string;
  status: string;
  link: { connectionId: string; path: string } | null;
  connections: { id: string; kind: string; label: string }[];
  versions: { id: string; message: string; auto: boolean; releases: string[] }[];
  branches: { name: string; head: string; current: boolean }[];
  workingChanges: { path: string; status: string }[] | null;
  compare: { addedVolume: number; removedVolume: number; added: number; removed: number } | null;
  conflicts: string[] | null;
  notice: string | null;
  history: string | null;
}

type Hooks = {
  __whittleApp: {
    apply(c: Command, label?: string): boolean;
    sync(): Promise<SyncState>;
    syncNow(): Promise<void>;
    syncLoaded(): boolean;
    projectBar(): { status: { state: string }; branch: string | null };
  };
  __whittleViewport: {
    getCompareStats(): {
      active: boolean;
      show: string;
      addedMeshes: number;
      removedMeshes: number;
    };
  };
};

const sync = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__whittleApp.sync());
const syncNow = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__whittleApp.syncNow());
const applyCmd = (page: Page, c: Command) =>
  page.evaluate((x) => (window as unknown as Hooks).__whittleApp.apply(x), c);
const focus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

const PART = fid('PART');
const POCKET = fid('PK');
const PLATE = fid('E1');

/** Plate 80 × 50 × 10 with a 20 × 20 × 4 pocket (no fillet: the removed volume is exact). */
function plateDoc(name: string, pocket: boolean): WhittleDoc {
  const d = pocketDoc();
  const part = d.parts[0] as WhittleDoc['parts'][number];
  const features = part.features
    .filter((f) => f.type !== 'fillet')
    .map((f) => (f.id === POCKET ? { ...f, suppressed: !pocket } : f));
  return {
    ...d,
    params: [...d.params, { id: fid('PRMW'), name: 'depth', expr: '10 mm' }],
    parts: [{ ...part, features, rollbackIndex: features.length }],
    meta: {
      ...d.meta,
      id: `01JM25${name.toUpperCase().replace(/\W/g, '')}`.padEnd(26, '0').slice(0, 26),
      name,
    },
  };
}

const paramExpr = (doc: WhittleDoc, name: string) => doc.params.find((p) => p.name === name)?.expr;

type How = 'click' | 'tap';
const press = (l: Locator, how: How) => (how === 'tap' ? l.tap() : l.click());

async function openPanel(page: Page, tab: 'Versions' | 'Connections', how: How = 'click') {
  const panel = page.getByTestId('project-panel');
  if (!(await panel.isVisible())) await press(page.getByTestId('versions-button'), how);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await press(panel.getByRole('radio', { name: tab }), how);
}

async function saveVersion(page: Page, message: string, how: How = 'click') {
  await openPanel(page, 'Versions', how);
  const panel = page.getByTestId('project-panel');
  const before = (await sync(page)).versions.filter((v) => !v.auto).length;
  await panel.getByLabel('Save version').fill(message);
  await press(panel.getByRole('button', { name: /Save version/ }), how);
  await expect
    .poll(async () => (await sync(page)).versions.filter((v) => !v.auto).length)
    .toBe(before + 1);
}

async function bodyVolume(page: Page): Promise<number> {
  await app(page).idle();
  const r = await app(page).regen();
  return (r?.bodies ?? []).reduce((s, b) => s + (b.volume ?? 0), 0);
}

async function newContext(
  browser: Browser,
  baseURL: string,
  kind: 'desktop' | 'ipad',
  init?: unknown,
) {
  const ctx = await browser.newContext(
    kind === 'desktop'
      ? { ...devices['Desktop Chrome'], baseURL }
      : {
          ...devices['Desktop Chrome'],
          viewport: devices['iPad Pro 11'].viewport,
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          baseURL,
        },
  );
  if (init !== undefined) {
    await ctx.addInitScript((o) => {
      (window as unknown as { __whittleSyncOverrides: unknown }).__whittleSyncOverrides = o;
    }, init);
  }
  return ctx;
}

// ------------------------------------------------------------------------------------ (c)

test('(c) compare with an earlier version: removed volume of the added pocket, red in the viewport', async ({
  page,
}) => {
  await boot(page);
  await app(page).load(plateDoc('Compare plate', false));
  expect(await bodyVolume(page)).toBeCloseTo(80 * 50 * 10, 6);
  expect(await page.evaluate(() => (window as unknown as Hooks).__whittleApp.syncLoaded())).toBe(
    false,
  );
  await saveVersion(page, 'Plate only');

  // "Add a hole": the 20 × 20 × 4 pocket.
  await applyCmd(page, {
    kind: 'setSuppressed',
    partId: PART,
    featureId: POCKET,
    suppressed: false,
  });
  expect(await bodyVolume(page)).toBeCloseTo(80 * 50 * 10 - 1600, 6);

  const panel = page.getByTestId('project-panel');
  const row = panel.locator('li[data-version-id]').filter({ hasText: 'Plate only' });
  await row.getByRole('button').first().click();
  await row.getByRole('button', { name: 'Compare with current' }).click();
  await expect(panel.getByTestId('compare-panel')).toBeVisible();
  await expect.poll(async () => (await sync(page)).compare, { timeout: 60_000 }).not.toBeNull();
  const c = (await sync(page)).compare;
  expect(Math.abs((c?.removedVolume ?? 0) - 1600)).toBeLessThan(1e-6);
  expect(c?.addedVolume ?? 1).toBeLessThan(1e-6);
  expect(c?.removed).toBeGreaterThan(0);
  await expect(panel.getByTestId('compare-geometry')).toContainText('removed');
  // The feature diff names the change.
  await expect(panel.getByTestId('compare-panel')).toContainText('Pocket');

  const stats = () =>
    page.evaluate(() => (window as unknown as Hooks).__whittleViewport.getCompareStats());
  expect(await stats()).toMatchObject({
    active: true,
    removedMeshes: 1,
    addedMeshes: 0,
    show: 'both',
  });
  // The legend swatches are the viewport's exact fills.
  const swatch = await panel
    .locator('[data-testid="compare-geometry"] [data-swatch="removed"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(swatch).toBe('rgb(194, 65, 12)'); // #c2410c, packages/viewport COMPARE_COLORS.light.removed
  // `show` toggles are bound to the panel.
  await panel.getByRole('radio', { name: 'Show added material' }).click();
  expect((await stats()).show).toBe('added');
  await panel.getByRole('radio', { name: 'Show removed material' }).click();
  expect((await stats()).show).toBe('removed');
  // Leaving compare removes the overlay (and releases the version slot).
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel.getByTestId('compare-panel')).toHaveCount(0);
  expect((await stats()).active).toBe(false);
});

// ------------------------------------------------------------------------------- Dropbox

test.describe
  .serial('Dropbox: desktop and iPad', () => {
    let dbx: FakeDropbox;
    let ctxA: BrowserContext;
    let ctxB: BrowserContext;
    let A: Page;
    let B: Page;

    test.beforeAll(async ({ browser, baseURL }) => {
      dbx = await startFakeDropbox(['/Bracket']);
      ctxA = await newContext(browser, baseURL ?? '', 'desktop', dropboxOverrides(dbx.origin));
      ctxB = await newContext(browser, baseURL ?? '', 'ipad', dropboxOverrides(dbx.origin));
      // Record when the app rewrites its address (the callback query must go only after the exchange).
      for (const ctx of [ctxA, ctxB]) {
        await ctx.addInitScript(() => {
          const w = window as unknown as { __strips: { at: number; url: string }[] };
          w.__strips = [];
          const orig = history.replaceState.bind(history);
          history.replaceState = (data, unused, url) => {
            w.__strips.push({ at: Date.now(), url: String(url ?? '') });
            return orig(data, unused, url);
          };
        });
      }
      A = await ctxA.newPage();
      B = await ctxB.newPage();
    });

    test.afterAll(async () => {
      await ctxA?.close();
      await ctxB?.close();
      await dbx?.close();
    });

    /** Connections → Add → Dropbox → (redirect to the fake, back) → the folder step. */
    async function signInToDropbox(page: Page, how: How) {
      await openPanel(page, 'Connections', how);
      const panel = page.getByTestId('project-panel');
      await press(panel.getByRole('button', { name: 'Add connection' }), how);
      let navigations = 0;
      const count = (f: { parentFrame(): unknown }) => {
        if (!f.parentFrame()) navigations += 1;
      };
      page.on('framenavigated', count);
      // Choosing Dropbox leaves for its sign-in page at once (full-page redirect, PKCE).
      await press(panel.getByRole('button', { name: /^Dropbox/ }), how);
      await expect(
        page.getByTestId('project-panel').getByText('Pick the project folder'),
      ).toBeVisible({
        timeout: 60_000,
      });
      const settled = navigations;
      await page.waitForTimeout(1500);
      page.off('framenavigated', count);
      return { navigations: settled, after: navigations };
    }

    test('(f) sign-in redirect round trip: no reload loop, the query stripped after the exchange', async () => {
      await boot(A);
      await app(A).load(plateDoc('Bracket', true));
      await app(A).idle();
      await app(A).flushSave();
      const tokenCalls = () => dbx.log.filter((l) => l.path === '/oauth2/token');
      const nav = await signInToDropbox(A, 'click');
      // Out to the provider and back is one commit of the app document (the 302 is not a page);
      // nothing reloads afterwards.
      expect(nav.after).toBe(nav.navigations);
      expect(nav.navigations).toBeLessThanOrEqual(2);
      const url = new URL(A.url());
      expect(url.searchParams.has('code')).toBe(false);
      expect(url.searchParams.has('state')).toBe(false);
      const token = tokenCalls()[0];
      expect(token).toBeTruthy();
      const strips = await A.evaluate(
        () => (window as unknown as { __strips: { at: number; url: string }[] }).__strips,
      );
      const strip = strips.find((s) => !s.url.includes('code='));
      expect(strip).toBeTruthy();
      expect(strip?.at ?? 0).toBeGreaterThanOrEqual(token?.at ?? Number.POSITIVE_INFINITY);
      // The user's place is restored: the same document, the Connections panel, the folder step.
      expect((await app(A).doc()).meta.name).toBe('Bracket');
      await expect(A.getByTestId('project-panel')).toHaveAttribute('data-tab', 'connections');
      const s = await sync(A);
      expect(s.connections.map((c) => c.kind)).toEqual(['dropbox']);
    });

    test('(e) tokens are not readable in plain text from IndexedDB or Web Storage', async () => {
      const secrets = [...dbx.issued, 'fake-refresh-token-secret'];
      expect(dbx.issued.length).toBeGreaterThan(0);
      const dump = await A.evaluate(async () => {
        const out: string[] = [];
        const seen = new WeakSet<object>();
        const text = (v: unknown): void => {
          if (v === null || v === undefined) return;
          if (typeof v === 'string') return void out.push(v);
          if (typeof v !== 'object') return void out.push(String(v));
          if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
            const b =
              v instanceof ArrayBuffer
                ? new Uint8Array(v)
                : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            out.push(new TextDecoder('utf-8', { fatal: false }).decode(b));
            out.push(Array.from(b, (c) => String.fromCharCode(c)).join(''));
            return;
          }
          if (v instanceof Blob) return;
          if (seen.has(v)) return;
          seen.add(v);
          for (const x of Object.values(v as Record<string, unknown>)) text(x);
          if (v instanceof Map) for (const entry of v) text(entry);
        };
        const stores: string[] = [];
        for (const info of await indexedDB.databases()) {
          if (!info.name) continue;
          const db = await new Promise<IDBDatabase>((res, rej) => {
            const r = indexedDB.open(info.name as string);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          for (const name of Array.from(db.objectStoreNames)) {
            stores.push(`${info.name}/${name}`);
            const tx = db.transaction(name, 'readonly');
            const all = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>(
              (res, rej) => {
                const k = tx.objectStore(name).getAllKeys();
                const v = tx.objectStore(name).getAll();
                tx.oncomplete = () => res({ keys: k.result, values: v.result });
                tx.onerror = () => rej(tx.error);
              },
            );
            text(all.keys);
            text(all.values);
          }
          db.close();
        }
        for (const s of [localStorage, sessionStorage])
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i) as string;
            out.push(k, s.getItem(k) ?? '');
          }
        return { text: out.join('\n'), stores };
      });
      // The vault is there (the scan isn't vacuous), and holds only ciphertext.
      expect(dump.stores.some((s) => /vault|credential/i.test(s))).toBe(true);
      for (const secret of secrets) expect(dump.text).not.toContain(secret);
    });

    test('(a) a parameter edited on the desktop shows on the iPad within 10 s of focusing', async () => {
      // Desktop: link the open project to the empty Dropbox folder (its files upload there).
      const panelA = A.getByTestId('project-panel');
      await panelA.getByRole('button', { name: 'Use folder Bracket' }).click();
      await expect
        .poll(async () => (await sync(A)).link?.path, { timeout: 30_000 })
        .toBe('/Bracket');
      await syncNow(A);
      expect(dbx.text('/Bracket/whittle.project.json')).toContain('Bracket');
      const volA = await bodyVolume(A);

      // iPad (touch only): sign in, open the project from the folder.
      await boot(B);
      await signInToDropbox(B, 'tap');
      await B.getByTestId('project-panel')
        .getByRole('button', { name: 'Open project Bracket' })
        .tap();
      await expect
        .poll(async () => (await app(B).doc()).meta.name, { timeout: 30_000 })
        .toBe('Bracket');
      await expect.poll(async () => (await sync(B)).link?.path).toBe('/Bracket');
      expect(Math.abs((await bodyVolume(B)) - volA)).toBeLessThan(1e-6 * volA);
      await B.getByTestId('project-panel')
        .getByRole('button', { name: 'Close project panel' })
        .tap();

      // Desktop: edit a parameter in the Params tab.
      await A.getByTestId('project-panel')
        .getByRole('button', { name: 'Close project panel' })
        .click();
      await A.getByRole('tab', { name: 'Params' }).click();
      const expr = A.getByRole('textbox', { name: 'Expression for pocket_x' });
      await expr.fill('35 mm');
      await expr.press('Enter');
      await expect.poll(async () => paramExpr(await app(A).doc(), 'pocket_x')).toBe('35 mm');
      await app(A).flushSave();

      // iPad gains focus; the change must be there within 10 s.
      const t0 = Date.now();
      await focus(B);
      await expect
        .poll(async () => paramExpr(await app(B).doc(), 'pocket_x'), {
          timeout: 10_000,
          intervals: [100],
        })
        .toBe('35 mm');
      const took = Date.now() - t0;
      expect(took).toBeLessThan(10_000);
      console.log(`desktop → iPad after focus: ${took} ms`);
      // One undo step, and the geometry followed.
      expect(await bodyVolume(B)).toBeCloseTo(volA, 6);
      await expect(B.getByTestId('sync-status')).toHaveAttribute('data-state', /idle|syncing/);
    });

    test('(b) concurrent offline edits: different features merge; the same parameter is resolved in the merge panel', async () => {
      const feature = async (page: Page, id: string) =>
        (await app(page).doc()).parts[0]?.features.find((f) => f.id === id);
      const setDepth = async (page: Page, id: string, depth: string) => {
        const f = await feature(page, id);
        if (f?.type !== 'extrude') throw new Error('not an extrude');
        expect(
          await applyCmd(page, {
            kind: 'updateFeature',
            partId: PART,
            featureId: id,
            feature: { ...f, end: { kind: 'blind', depth } },
          }),
        ).toBe(true);
      };
      const depthOf = async (page: Page, id: string) => {
        const f = await feature(page, id);
        return f?.type === 'extrude' && f.end.kind === 'blind' ? f.end.depth : null;
      };

      // 1. Both offline; each edits a different feature.
      await ctxA.setOffline(true);
      await ctxB.setOffline(true);
      await setDepth(A, POCKET, '5');
      await setDepth(B, PLATE, '12');
      await app(A).flushSave();
      await app(B).flushSave();
      await expect.poll(async () => (await sync(A)).status).toBe('offline');
      await ctxA.setOffline(false);
      await syncNow(A);
      await ctxB.setOffline(false);
      await syncNow(B);
      await syncNow(A);
      for (const p of [A, B]) {
        expect(await depthOf(p, POCKET)).toBe('5');
        expect(await depthOf(p, PLATE)).toBe('12');
        expect((await sync(p)).status).toBe('idle');
      }

      // 2. Both offline; both change the same parameter.
      await ctxA.setOffline(true);
      await ctxB.setOffline(true);
      const pid = (await app(A).doc()).params.find((p) => p.name === 'pocket_x')?.id as string;
      await applyCmd(A, { kind: 'updateParam', paramId: pid, expr: '31 mm' });
      await applyCmd(B, { kind: 'updateParam', paramId: pid, expr: '32 mm' });
      await app(A).flushSave();
      await app(B).flushSave();
      await ctxA.setOffline(false);
      await syncNow(A);
      await ctxB.setOffline(false);
      await syncNow(B);
      await expect.poll(async () => (await sync(B)).status, { timeout: 20_000 }).toBe('conflicts');
      // Nothing conflicting was uploaded: the remote still has the desktop's value.
      expect(dbx.text('/Bracket/params.json')).toContain('31 mm');

      // Resolve by touch on the iPad: the chip's Resolve opens the merge panel.
      const chip = B.getByTestId('sync-status');
      await expect(chip).toHaveAttribute('data-state', 'conflicts');
      await chip.getByRole('button', { name: 'Resolve' }).tap();
      const merge = B.getByTestId('merge-panel');
      await expect(merge).toBeVisible();
      expect((await sync(B)).conflicts).toEqual([`/params/${pid}/expr`]);
      await expect(merge).toContainText('31 mm');
      await expect(merge).toContainText('32 mm');
      await merge.getByRole('button', { name: 'Take theirs' }).tap();
      await merge.getByRole('button', { name: 'Finish merge' }).tap();
      await expect(merge).toHaveCount(0, { timeout: 20_000 });
      await syncNow(B);
      await syncNow(A);

      // Final document, identical on both: every edit is still there, and the chosen value.
      for (const p of [A, B]) {
        const d = await app(p).doc();
        expect(paramExpr(d, 'pocket_x')).toBe('31 mm');
        expect(await depthOf(p, POCKET)).toBe('5');
        expect(await depthOf(p, PLATE)).toBe('12');
        expect((await sync(p)).status).toBe('idle');
      }
      const a = await app(A).doc();
      const b = await app(B).doc();
      expect(b.params).toEqual(a.params);
      expect(b.parts).toEqual(a.parts);
    });
  });

// ----------------------------------------------------------------------------------- (d)

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim();

async function connectGitHost(page: Page, repoUrl: string, token: string) {
  await openPanel(page, 'Connections');
  const panel = page.getByTestId('project-panel');
  await panel.getByRole('button', { name: 'Add connection' }).click();
  await panel.getByRole('button', { name: /^GitHub/ }).click();
  await panel.getByLabel('Repository').fill(repoUrl);
  await panel.getByLabel('Fine-grained token').fill(token);
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.getByText('Pick the project folder')).toBeVisible({ timeout: 30_000 });
}

test('(d) git host: commit, push, clone on another device, regenerate with the same volume', async ({
  browser,
  baseURL,
}) => {
  const TOKEN = 'github_pat_e2e_secret';
  // Like a private GitHub repository: only `x-access-token:<token>` gets in.
  const server: GitServer = await startGitServer(
    'other',
    { 'README.md': 'x\n' },
    { auth: `x-access-token:${TOKEN}` },
  );
  server.empty('bracket');
  const url = `${server.url}/bracket.git`;
  const ctxA = await newContext(browser, baseURL ?? '', 'desktop');
  const ctxB = await newContext(browser, baseURL ?? '', 'desktop');
  try {
    const A = await ctxA.newPage();
    await boot(A);
    await app(A).load(plateDoc('Git bracket', true));
    await app(A).idle();
    await app(A).flushSave();
    await connectGitHost(A, url, TOKEN);
    const pA = A.getByTestId('project-panel');
    await pA.getByRole('button', { name: 'Use folder bracket' }).click();
    const remoteLog = () => {
      try {
        return server.git('bracket.git', 'log', '--format=%s');
      } catch {
        return ''; // no commits yet
      }
    };
    await expect.poll(remoteLog, { timeout: 60_000 }).toContain('First version from Whittle');
    expect((await sync(A)).kind).toBe('git');

    // An edit, saved as a named version (a commit), then pushed.
    await applyCmd(A, { kind: 'updateParam', paramId: fid('PRMW'), expr: '14 mm' });
    const d = (await app(A).doc()).parts[0]?.features.find((f) => f.id === PLATE);
    if (d?.type !== 'extrude') throw new Error('plate');
    await applyCmd(A, {
      kind: 'updateFeature',
      partId: PART,
      featureId: PLATE,
      feature: { ...d, end: { kind: 'blind', depth: 'depth' } },
    });
    const volA = await bodyVolume(A);
    expect(volA).toBeCloseTo(80 * 50 * 14 - 1600, 6);
    await app(A).flushSave();
    await saveVersion(A, 'Thicker plate');
    await pA.getByTestId('git-push').click();
    await expect.poll(remoteLog, { timeout: 30_000 }).toContain('Thicker plate');

    // Another device clones it into its library and regenerates.
    const B = await ctxB.newPage();
    await boot(B);
    await connectGitHost(B, url, TOKEN);
    await B.getByTestId('project-panel')
      .getByRole('button', { name: 'Open project bracket' })
      .click();
    await expect
      .poll(async () => (await app(B).doc()).meta.name, { timeout: 60_000 })
      .toBe('Git bracket');
    const volB = await bodyVolume(B);
    expect(Math.abs(volB - volA) / volA).toBeLessThan(1e-9);
    const sB = await sync(B);
    expect(sB.kind).toBe('git');
    expect(sB.versions.map((v) => v.message)).toEqual(
      expect.arrayContaining(['Thicker plate', 'First version from Whittle']),
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
    server.close();
  }
});

// ----------------------------------------------------------------------------------- (g)

/** Every file of a directory tree, base64 (to copy a real repo into OPFS). */
function treeOf(dir: string, rel = ''): { path: string; b64: string }[] {
  const out: { path: string; b64: string }[] = [];
  for (const e of fs.readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...treeOf(dir, p));
    else out.push({ path: p, b64: fs.readFileSync(join(dir, p)).toString('base64') });
  }
  return out;
}

const OPFS_REPO = 'e2e-repo';

async function writeOpfs(page: Page, files: { path: string; b64: string }[]) {
  await page.evaluate(
    async ({ files, name }) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, {
        create: true,
      });
      for (const f of files) {
        const segs = f.path.split('/');
        const file = segs.pop() as string;
        let d = root;
        for (const s of segs) d = await d.getDirectoryHandle(s, { create: true });
        const w = await (await d.getFileHandle(file, { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
        await w.close();
      }
    },
    { files, name: OPFS_REPO },
  );
}

async function readOpfs(page: Page): Promise<{ path: string; b64: string }[]> {
  return page.evaluate(async (name) => {
    const out: { path: string; b64: string }[] = [];
    const walk = async (d: FileSystemDirectoryHandle, rel: string) => {
      for await (const [n, h] of (
        d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
      ).entries()) {
        const p = rel ? `${rel}/${n}` : n;
        if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, p);
        else {
          const b = new Uint8Array(
            await (await (h as FileSystemFileHandle).getFile()).arrayBuffer(),
          );
          let s = '';
          for (let i = 0; i < b.length; i += 0x8000)
            s += String.fromCharCode(...b.subarray(i, i + 0x8000));
          out.push({ path: p, b64: btoa(s) });
        }
      }
    };
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(name), '');
    return out;
  }, OPFS_REPO);
}

function materialise(files: { path: string; b64: string }[]): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'whittle-opfs-'));
  for (const f of files) {
    fs.mkdirSync(join(dir, f.path, '..'), { recursive: true });
    fs.writeFileSync(join(dir, f.path), Buffer.from(f.b64, 'base64'));
  }
  return dir;
}

test('(g) local git repo: a saved version is a commit git sees; outside edits are uncommitted; no branch switch over them', async ({
  browser,
  baseURL,
}) => {
  // A real repository made with the git CLI, copied into OPFS (the picked folder's stand-in).
  const seed = fs.mkdtempSync(join(tmpdir(), 'whittle-seed-'));
  sh(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(join(seed, 'README.md'), '# Parts\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'seed');
  sh(seed, 'branch', 'idea');
  const ctx = await newContext(browser, baseURL ?? '', 'desktop');
  await ctx.addInitScript((name) => {
    const w = window as unknown as { __whittleSyncOverrides: Record<string, unknown> };
    w.__whittleSyncOverrides = {
      ...(w.__whittleSyncOverrides ?? {}),
      pickDirectory: async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true }),
    };
  }, OPFS_REPO);
  const dumps: string[] = [seed];
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[g pageerror] ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && console.log(`[g console] ${m.text()}`));
    await boot(page);
    await writeOpfs(page, treeOf(seed));
    await app(page).load(plateDoc('Local git plate', true));
    await app(page).idle();
    await app(page).flushSave();

    await openPanel(page, 'Connections');
    const panel = page.getByTestId('project-panel');
    await panel.getByTestId('open-local-git').click();
    await expect(panel.getByText('Pick the project folder')).toBeVisible({ timeout: 30_000 });
    await panel.getByRole('button', { name: /Use folder e2e-repo \(repository root\)/ }).click();
    await expect.poll(async () => (await sync(page)).kind, { timeout: 30_000 }).toBe('localGit');
    await syncNow(page);

    // Versions: the repo's own history, and the offer to keep the cache out of git.
    await openPanel(page, 'Versions');
    await expect(panel.getByTestId('gitignore-offer')).toBeVisible();
    await expect
      .poll(async () => (await sync(page)).versions.map((v) => v.message))
      .toContain('seed');
    expect((await sync(page)).branches.map((b) => b.name).sort()).toEqual(['idea', 'main']);
    await saveVersion(page, 'Plate from Whittle');

    // git itself sees the commit, with a clean working tree.
    const repo = materialise(await readOpfs(page));
    dumps.push(repo);
    expect(sh(repo, 'log', '--format=%s', 'main')).toBe('Plate from Whittle\nseed');
    expect(sh(repo, 'status', '--porcelain')).toBe('');
    expect(sh(repo, 'show', '--stat', '--format=', 'HEAD')).toContain('whittle.project.json');

    // Edited outside Whittle (an editor, a script): the working tree changes on disk.
    await page.evaluate(async (name) => {
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
      const fh = await d.getFileHandle('params.json');
      const text = await (await fh.getFile()).text();
      const w = await fh.createWritable();
      await w.write(text.replace('30 mm', '33 mm'));
      await w.close();
    }, OPFS_REPO);
    await focus(page);
    await expect
      .poll(async () => paramExpr(await app(page).doc(), 'pocket_x'), { timeout: 20_000 })
      .toBe('33 mm');
    await expect
      .poll(async () => (await sync(page)).workingChanges, { timeout: 20_000 })
      .toEqual([{ path: 'params.json', status: 'modified' }]);
    await expect(panel.getByTestId('uncommitted')).toContainText('Uncommitted changes · 1 file');

    // Switching branches over uncommitted changes is refused; nothing is touched.
    await panel.getByLabel('Branch').selectOption('idea');
    await expect(panel.getByTestId('project-notice')).toContainText('uncommitted changes');
    const s = await sync(page);
    expect(s.branches.find((b) => b.current)?.name).toBe('main');
    expect(paramExpr(await app(page).doc(), 'pocket_x')).toBe('33 mm');
    const after = materialise(await readOpfs(page));
    dumps.push(after);
    expect(sh(after, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fs.readFileSync(join(after, 'params.json'), 'utf8')).toContain('33 mm');
  } finally {
    await ctx.close();
    for (const d of dumps) fs.rmSync(d, { recursive: true, force: true });
  }
});
