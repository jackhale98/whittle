import { expect, type Page, test } from '@playwright/test';
import type { Command, WrenDoc } from '@wren-cad/contracts';
import { app, boot } from './helpers';

/**
 * M3.6 acceptance: a folder renamed on one version and moved on another merges cleanly through the
 * app's real merge path (the sync controller's `mergeDiverged`: three-way merge of the base and
 * the two heads, id-keyed folders), with no conflicts and both changes in the result.
 *
 * There is no button that merges two local branches (the Versions panel offers a merge for
 * diverged sync heads), so the test builds the two versions through the controller (as the sync
 * specs do) and calls its merge function.
 */

type Ctl = {
  saveVersion(message: string): Promise<void>;
  createBranch(name: string): Promise<void>;
  switchBranch(name: string): Promise<void>;
  mergeDiverged(theirs: string): Promise<void>;
  idle(): Promise<void>;
  testState(): Promise<{
    branches: { name: string; head: string; current: boolean }[];
    conflicts: string[] | null;
    versions: { id: string; message: string }[];
    currentId: string | null;
  }>;
};
type Hooks = { __wrenApp: { syncController(): Promise<Ctl> } };

const part = async (page: Page) => (await app(page).doc()).parts[0] as WrenDoc['parts'][number];
const names = (p: WrenDoc['parts'][number]) => p.features.map((f) => f.name);
/** Calls a method of the sync controller (the app's own object) inside the page. */
const call = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    async ([m, rest]) => {
      const c = await (window as unknown as Hooks).__wrenApp.syncController();
      return (c as unknown as Record<string, (...x: unknown[]) => unknown>)[m as string]?.(
        ...(rest as unknown[]),
      );
    },
    [method, args] as const,
  );
const state = async (page: Page) => {
  await call(page, 'idle');
  return (await call(page, 'testState')) as Awaited<ReturnType<Ctl['testState']>>;
};

test('a folder renamed on one version and moved on another merges cleanly', async ({ page }) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await page.getByTestId('open-demo').click();
  await expect.poll(async () => (await part(page)).features.length).toBe(9);
  await a.idle();
  const p0 = await part(page);
  const partId = p0.id;
  const run = p0.features.slice(4, 7).map((f) => f.id);
  const edit = async (c: Command) => {
    expect(await a.apply(c)).toBe(true);
    await a.idle();
    await a.flushSave();
  };

  // The base: a folder of three features.
  const folderId = '01JM36FOLDER0000000000000A';
  await edit({
    kind: 'addFolder',
    partId,
    folder: { id: folderId, name: 'Folder 1', features: run },
  });

  // Open the Versions panel so the project's history is open, then save the base version.
  await page.getByTestId('versions-button').click();
  await expect(page.getByTestId('project-panel')).toBeVisible();
  await call(page, 'saveVersion', 'Base');
  const base = await state(page);
  const mainName = base.branches.find((b) => b.current)?.name as string;
  expect(mainName).toBeTruthy();

  // Version one (a branch): the folder is renamed.
  await call(page, 'createBranch', 'rename');
  await edit({ kind: 'renameFolder', partId, folderId, name: 'Upright group' });
  await call(page, 'saveVersion', 'Rename the folder');
  const renameHead = (await state(page)).branches.find((b) => b.name === 'rename')?.head as string;
  expect(renameHead).toBeTruthy();

  // Version two (the main line): the folder moves above "Holes".
  await call(page, 'switchBranch', mainName);
  await expect.poll(async () => (await part(page)).folders?.[0]?.name).toBe('Folder 1');
  await edit({ kind: 'moveFolder', partId, folderId, toIndex: 2 });
  await call(page, 'saveVersion', 'Move the folder');
  const movedOrder = names(await part(page));
  expect(movedOrder.indexOf('Upright')).toBeLessThan(movedOrder.indexOf('Holes'));

  // Merge the renamed version into this one: clean, both changes present, one undo step.
  const past = (await a.history()).past.length;
  await call(page, 'mergeDiverged', renameHead);
  await call(page, 'idle');
  await expect.poll(async () => (await part(page)).folders?.[0]?.name).toBe('Upright group');
  const merged = await part(page);
  expect(names(merged)).toEqual(movedOrder);
  expect(merged.folders).toHaveLength(1);
  expect(merged.folders?.[0]?.id).toBe(folderId);
  expect(merged.folders?.[0]?.features).toEqual(
    p0.features.filter((f) => run.includes(f.id)).map((f) => f.id),
  );
  expect((await state(page)).conflicts).toBeNull(); // no merge panel: nothing to decide
  await expect(page.getByTestId('merge-panel')).toHaveCount(0);
  expect((await a.history()).past.length).toBe(past + 1);
  await a.idle();
  // The merged model regenerates cleanly.
  expect((await a.regen())?.features.every((f) => f.state === 'ok')).toBe(true);
});
