/**
 * Connections, background sync, versions, compare and merge for the open project (PLAN §8A,
 * M2.5). Lazy: this module (with `@wren-cad/sync` and isomorphic-git) loads only when the user
 * opens Connections or Versions, a linked project (or one with history) opens, or the page is an
 * OAuth callback. The workbench reaches it only through `SyncHost`.
 *
 * - One `SyncEngine` per open linked project (file services, and local git repos where the
 *   project folder on disk is the working copy, ADR-029). The library entry is the engine's
 *   local working copy; merged results land in the open document as one undo step.
 * - History: `SnapshotHistory` in the project's `.wren-history/` extra files (they sync with
 *   it); `GitHistory` for git hosts (LightningFS clone) and local git repos (the folder).
 * - Compare regenerates a version in a `version:<id>` regen slot beside the live model.
 */

import type {
  Author,
  Branch,
  Connection,
  CredentialVault,
  DiffChange,
  EvalResult,
  Expr,
  GeometricDiff,
  GitHistory,
  HistoryStore,
  Id,
  JsonPatchOp,
  MergeResolution,
  MergeResult,
  MeshQuality,
  ProjectFiles,
  ProjectLink,
  ProviderKind,
  RegenSlot,
  RemoteFolder,
  StorageProvider,
  StorageResult,
  SyncStatus,
  TouchViewport,
  Version,
  WrenDoc,
} from '@wren-cad/contracts';
import { resolveConfiguration, slugify, ulid } from '@wren-cad/document';
import {
  beginSignIn,
  browserGitFs,
  browserGitHttp,
  completeSignIn,
  createCredentialVault,
  createGitHistory,
  createIdbSyncStore,
  createProvider,
  createSnapshotHistory,
  createSyncEngine,
  DEFAULT_PRUNE_POLICY,
  DropboxProvider,
  docDiffer,
  docMerger,
  type FolderHandle,
  FolderProvider,
  type GitHost,
  GraphAccount,
  gitRemoteHeads,
  type HistoryFiles,
  hashProjectFiles,
  type LocalGitRepo,
  loadFolderHandle,
  mergeNotes,
  mergeProjectFiles,
  oauthTokenSource,
  type ProjectSyncEngine,
  refresherFor,
  resolveProjectFiles,
  saveFolderHandle,
  stripCallbackQuery,
  syncable,
  versionedFiles,
} from '@wren-cad/sync';
import type {
  ConnectionItem,
  DivergedNotice,
  FolderBrowse,
  MergeChoice,
  ProviderOption,
  TokenForm,
  WebDavForm,
} from '@wren-cad/ui';
import { type Observable, observable } from '../app/observable';
import type { DocLibrary } from '../doc/library';
import type { Modeling } from '../model/modeling';
import {
  canPickDirectory,
  hasOAuthCallback,
  oauthConfig,
  pickDirectory,
  providerAvailability,
  rewrite,
  syncConfig,
  syncFetch,
} from './env';
import { isGitRepo, openLocalGit } from './local-git';
import {
  cloneUrl,
  linkOf,
  loadConnections,
  loadHistoryState,
  projectsPer,
  removeConnection,
  saveConnection,
  saveHistoryState,
  setLink,
} from './store';
import {
  applyChanges,
  changedPaths,
  HISTORY_PREFIX,
  patchTo,
  projectFiles,
  restoredExtra,
  splitProject,
} from './working-copy';

/** What the controller needs from the workbench (implemented there; tests can fake it). */
export interface SyncHost {
  currentId(): string | undefined;
  doc(): WrenDoc;
  extra(): ProjectFiles;
  /** Runs `fn` with the library, one at a time with the app's own saves (null: no storage). */
  lockLibrary<T>(fn: (lib: DocLibrary) => Promise<T>): Promise<T | null>;
  /**
   * Whether sync may replace the open document now: it is exactly what was last saved (no
   * pending or in-flight save, no unsaved history files) and the user isn't mid-edit (a sketch
   * session or a drag; sync runs again once they finish).
   */
  canAdoptRemote(): boolean;
  /**
   * Sync wrote merged files to the library: show them as one undo step (`ops` from the open
   * document to `doc`, keeping `doc`'s modified time) that is not saved back.
   */
  adoptRemote(doc: WrenDoc, extra: ProjectFiles, ops: JsonPatchOp[]): void;
  /** Replaces the open project as one undoable edit (restore, branch switch, merge). */
  applyFiles(extra: ProjectFiles, label: string, ops: JsonPatchOp[]): boolean;
  /** Writes (`null`: removes) extra files of the open project in memory; `persist` saves them. */
  setExtraFiles(changes: ReadonlyMap<string, Uint8Array | null>): void;
  /** Saves the open document and its extra files to the library now. */
  persist(): Promise<void>;
  /** Flushes pending autosave. */
  flush(): Promise<void>;
  /** Saves a new library project and opens it. */
  openNewProject(doc: WrenDoc, extra: ProjectFiles): Promise<boolean>;
  modeling(): Promise<Modeling | null>;
  viewport(): TouchViewport | null;
  attachments(doc: WrenDoc): Record<string, Uint8Array>;
  evaluate(expr: Expr): EvalResult;
  toast(text: string, tone?: 'info' | 'error'): void;
  /** Top bar state. */
  setBar(bar: { status: SyncStatus; branch: string | null }): void;
  openPanel(tab: PanelTab): void;
}

export type PanelTab = 'versions' | 'connections';

export type ProjectKind = 'local' | 'file' | 'git' | 'localGit';

export interface HistoryView {
  backend: 'snapshot' | 'git';
  versions: Version[];
  branches: Branch[];
  currentId?: string;
  diverged: DivergedNotice | null;
  /** Local git mode. */
  workingChanges?: { path: string; status: 'added' | 'modified' | 'deleted' }[];
  /** Why the repo is read-only right now (a merge in progress…), from `state()`; null: it isn't. */
  readOnly?: string | null;
  cacheIgnored?: boolean;
  /** Git: push and pull are offered (a remote, signed in). */
  canPushPull?: boolean;
  remoteNote?: string;
}

export interface CompareMode {
  kind: 'compare';
  versionId: string;
  beforeLabel: string;
  changes: DiffChange[];
  geometry: GeometricDiff | null;
  state: 'ready' | 'loading' | 'unavailable';
  overlay: 'both' | 'added' | 'removed';
}

export interface MergeMode {
  kind: 'merge';
  result: MergeResult;
  resolutions: MergeResolution[];
  oursLabel: string;
  theirsLabel: string;
  finishing: boolean;
  error?: string;
}

export interface SyncView {
  connections: ConnectionItem[];
  providers: ProviderOption[];
  localGit: { available: boolean; reason?: string };
  signingIn: ProviderKind | null;
  addError: string | null;
  browse: (FolderBrowse & { connectionId: Id }) | null;
  project: {
    id: string | null;
    kind: ProjectKind;
    linkLabel?: string;
    status: SyncStatus;
    history: HistoryView | null;
    saving: boolean;
    saveError: string | null;
    notice: string | null;
    /** `refresh`: the notice is a `CONFLICT` with something changed outside Wren. */
    noticeAction: 'refresh' | null;
    busy: string | null;
  };
  mode: CompareMode | MergeMode | null;
}

const AUTHOR: Author = { name: 'Wren user' };
const AUTO_EVERY_MS = 10 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const PLACE_KEY = 'whittle:oauth-place';
const PREVIEW_SLOT: RegenSlot = 'version:merge-preview';

const OAUTH_KINDS = new Set<ProviderKind>(['dropbox', 'onedrive', 'gdrive']);
const GIT_KINDS = new Set<ProviderKind>(['github', 'gitlab', 'bitbucket', 'forgejo']);

function providerOptions(): ProviderOption[] {
  const avail = new Map(providerAvailability().map((p) => [p.id, p]));
  const token = avail.get('git-token');
  const opt = (kind: ProviderKind, id: string): ProviderOption => {
    const a = avail.get(id as never);
    return a?.available
      ? { kind, available: true }
      : { kind, available: false, reason: a?.reason ?? 'Not available in this build.' };
  };
  const folder: ProviderOption = canPickDirectory()
    ? { kind: 'folder', available: true }
    : {
        kind: 'folder',
        available: false,
        reason: 'Needs a desktop Chromium browser (Chrome, Edge) to open folders.',
      };
  const git = (kind: ProviderKind): ProviderOption =>
    token?.available
      ? { kind, available: true }
      : { kind, available: false, reason: token?.reason ?? 'Not available.' };
  return [
    folder,
    opt('dropbox', 'dropbox'),
    opt('onedrive', 'onedrive'),
    { kind: 'gdrive', available: false, reason: 'Google Drive arrives after M2.5 (see ADR-024).' },
    opt('webdav', 'webdav'),
    git('github'),
    git('gitlab'),
    git('bitbucket'),
    git('forgejo'),
  ];
}

const gitHost = (k: Connection['kind']): GitHost =>
  k === 'github' || k === 'gitlab' || k === 'bitbucket' || k === 'forgejo' ? k : 'other';

const errText = (r: { ok: false; error: { message: string } }) => r.error.message;

export class SyncController {
  readonly view: Observable<SyncView>;
  readonly vault: CredentialVault;
  private connections: Connection[] = loadConnections();
  private engine: ProjectSyncEngine | null = null;
  private engineOff: (() => void) | null = null;
  private history: HistoryStore | null = null;
  private localRepo: LocalGitRepo | null = null;
  private projectId: string | null = null;
  private link: ProjectLink | null = null;
  private lastFiles = new Map<string, ProjectFiles>();
  private lastAuto = 0;
  private lastPrune = 0;
  private compareSlot: { partId: Id; slot: RegenSlot } | null = null;
  private mergeFinish: ((r: MergeResolution[]) => Promise<StorageResult<unknown>>) | null = null;
  private offFocus: (() => void) | null = null;
  private opening: Promise<void> = Promise.resolve();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: SyncHost) {
    this.vault = createCredentialVault();
    this.view = observable<SyncView>({
      connections: [],
      providers: providerOptions(),
      localGit: canPickDirectory()
        ? { available: true }
        : {
            available: false,
            reason:
              'Local git repos need a desktop Chromium browser (Chrome, Edge): other browsers can’t open folders.',
          },
      signingIn: null,
      addError: null,
      browse: null,
      project: {
        id: null,
        kind: 'local',
        status: { state: 'local' },
        history: null,
        saving: false,
        saveError: null,
        notice: null,
        noticeAction: null,
        busy: null,
      },
      mode: null,
    });
    void this.refreshConnections();
    const onFocus = () => void this.onFocus();
    window.addEventListener('focus', onFocus);
    this.offFocus = () => window.removeEventListener('focus', onFocus);
  }

  dispose(): void {
    this.offFocus?.();
    this.stopEngine();
  }

  private patch(p: Partial<SyncView>): void {
    this.view.set((v) => ({ ...v, ...p }));
  }

  private patchProject(p: Partial<SyncView['project']>): void {
    this.view.set((v) => ({ ...v, project: { ...v.project, ...p } }));
    const pr = this.view.get().project;
    const branch = pr.history?.branches.find((b) => b.current)?.name ?? null;
    this.host.setBar({ status: pr.status, branch: pr.history ? (branch ?? 'main') : null });
  }

  // ---------------------------------------------------------------- connections

  private async health(c: Connection): Promise<ConnectionItem['health']> {
    if (c.kind === 'folder') return 'connected';
    return (await this.vault.get(c.id).catch(() => null)) ? 'connected' : 'signedOut';
  }

  async refreshConnections(): Promise<void> {
    const per = projectsPer();
    const items: ConnectionItem[] = [];
    for (const c of this.connections) {
      const n = per.get(c.id);
      items.push({ connection: c, health: await this.health(c), ...(n ? { projects: n } : {}) });
    }
    this.patch({ connections: items, providers: providerOptions() });
  }

  private addConnection(c: Connection): void {
    this.connections = saveConnection(c);
    void this.refreshConnections();
  }

  async removeConnection(id: Id): Promise<void> {
    this.connections = removeConnection(id);
    await this.vault.remove(id).catch(() => undefined);
    if (this.link?.connectionId === id) await this.openProject(this.projectId);
    await this.refreshConnections();
  }

  cancelAdd(): void {
    this.patch({ signingIn: null, addError: null, browse: null });
  }

  /** OAuth: leaves for the provider (full-page redirect). */
  async signIn(kind: ProviderKind, renew?: Id): Promise<void> {
    if (!OAUTH_KINDS.has(kind)) return;
    this.patch({ signingIn: kind, addError: null });
    await this.host.flush();
    try {
      sessionStorage.setItem(
        PLACE_KEY,
        JSON.stringify({ doc: this.host.currentId() ?? null, tab: 'connections' }),
      );
    } catch {
      // The place is a convenience: sign-in still works without it.
    }
    const r = await beginSignIn(
      kind as 'dropbox' | 'onedrive' | 'gdrive',
      oauthConfig(),
      { returnTo: location.pathname, ...(renew ? { renew } : {}) },
      { navigate: (url) => location.assign(rewrite(url)) },
    );
    if (!r.ok) this.patch({ signingIn: null, addError: errText(r) });
  }

  /** On boot with `?code=…&state=…`: trade the code, store the tokens, then strip the query. */
  async completeSignIn(): Promise<void> {
    if (!hasOAuthCallback()) return;
    this.host.openPanel('connections');
    const r = await completeSignIn(new URLSearchParams(location.search), oauthConfig(), {
      vault: this.vault,
      fetch: syncFetch,
    });
    if (!r.ok) {
      // The one-time code is spent either way: never retry it on a reload.
      stripCallbackQuery();
      this.patch({ addError: errText(r) });
      return;
    }
    const { service, connectionId, renewed } = r.value;
    if (!renewed) {
      const label =
        service === 'dropbox' ? 'Dropbox' : service === 'onedrive' ? 'OneDrive' : 'Google Drive';
      if (service === 'onedrive') {
        const acct = new GraphAccount(this.tokens(connectionId, 'onedrive'), syncFetch);
        const drive = await acct.myDrive();
        if (!drive.ok) {
          this.patch({ addError: errText(drive) });
          return;
        }
        this.addConnection({
          id: connectionId,
          kind: 'onedrive',
          label,
          driveId: drive.value.id,
          driveName: drive.value.name,
        });
      } else {
        let account: string | undefined;
        if (service === 'dropbox') {
          const a = await new DropboxProvider(
            this.tokens(connectionId, 'dropbox'),
            syncFetch,
          ).account();
          if (a.ok) account = a.value.email || a.value.name;
        }
        this.addConnection({
          id: connectionId,
          kind: service,
          label,
          ...(account ? { account } : {}),
        });
      }
    }
    await this.refreshConnections();
    if (!renewed) await this.browse(connectionId, '');
  }

  private tokens(connectionId: Id, service: 'dropbox' | 'onedrive' | 'gdrive') {
    return oauthTokenSource({
      connectionId,
      vault: this.vault,
      refresh: refresherFor(service, oauthConfig(), syncFetch),
      service,
    });
  }

  async addWebDav(form: WebDavForm): Promise<void> {
    const id = ulid();
    let label = 'WebDAV';
    try {
      label = new URL(form.url).host;
    } catch {
      /* the panel validated the URL */
    }
    const c: Connection = {
      id,
      kind: 'webdav',
      label,
      url: form.url,
      username: form.username,
      relay: form.relay,
    };
    await this.vault.set(id, {
      kind: 'password',
      username: form.username,
      password: form.password,
    });
    const p = await this.providerFor(c);
    if (!p.ok) {
      await this.vault.remove(id);
      this.patch({ addError: errText(p) });
      return;
    }
    const probe = await p.value.browse('');
    if (!probe.ok) {
      await this.vault.remove(id);
      this.patch({ addError: errText(probe) });
      return;
    }
    this.addConnection(c);
    this.patch({
      addError: null,
      browse: { connectionId: id, connectionLabel: label, path: '', folders: probe.value },
    });
  }

  /**
   * Git host with an access token. GitHub takes the token as the password with the username
   * `x-access-token` (`basicAuth`); the form's empty username is never stored, so no host gets
   * `username: ''`.
   */
  async addToken(form: TokenForm): Promise<void> {
    const url = cloneUrl(form.host, form.repo);
    if (!url) {
      this.patch({
        addError: 'That repository address isn’t one Wren can use. Try owner/name.',
      });
      return;
    }
    const id = ulid();
    const host = new URL(url).host;
    const name =
      url
        .split('/')
        .pop()
        ?.replace(/\.git$/, '') ?? 'Repository';
    const username = form.username.trim();
    await this.vault.set(id, {
      kind: 'token',
      token: form.token,
      ...(username ? { username } : {}),
    });
    const heads = await gitRemoteHeads({
      http: browserGitHttp,
      url,
      host: gitHost(form.kind),
      credentials: () => this.vault.get(id),
      corsProxy: syncConfig().gitCorsProxy || null,
    });
    if (!heads.ok) {
      await this.vault.remove(id);
      this.patch({ addError: errText(heads) });
      return;
    }
    this.addConnection({ id, kind: form.kind, label: name, host });
    this.patch({
      addError: null,
      browse: {
        connectionId: id,
        connectionLabel: host,
        path: '',
        folders: [{ name, path: url, isProject: heads.value.length > 0 }],
      },
    });
  }

  /** Picked folders this session (IndexedDB holds them across reloads; reading is not free). */
  private readonly handles = new Map<string, FolderHandle>();

  private async folderHandle(key: string): Promise<FolderHandle | null> {
    const known = this.handles.get(key);
    if (known) return known;
    const h = await loadFolderHandle(key).catch(() => null);
    if (h) this.handles.set(key, h);
    return h;
  }

  /** A folder on this device; a git working tree becomes a local git repo (ADR-029). */
  async addLocalFolder(): Promise<void> {
    const handle = await pickDirectory();
    if (!handle) return;
    const git = await isGitRepo(handle);
    const id = ulid();
    let handleKey: string;
    try {
      handleKey = await saveFolderHandle(handle as unknown as FolderHandle);
    } catch (e) {
      this.patch({
        addError: `This browser can’t remember the folder ‘${handle.name}’ (${e instanceof Error ? e.message : e}).`,
      });
      return;
    }
    this.handles.set(handleKey, handle as unknown as FolderHandle);
    this.addConnection({
      id,
      kind: 'folder',
      label: handle.name,
      handleKey,
      ...(git ? { git: true } : {}),
    });
    await this.browse(id, '');
  }

  async browse(connectionId: Id, path: string): Promise<void> {
    const c = this.connections.find((x) => x.id === connectionId);
    if (!c) return;
    if (GIT_KINDS.has(c.kind)) return; // one repository per token connection: nothing to browse
    const label = c.kind === 'folder' ? c.label : ('account' in c && c.account) || c.label;
    this.patch({ browse: { connectionId, connectionLabel: label, path, folders: null } });
    if (c.kind === 'folder' && c.git) {
      // A project is the repo root or any folder inside it (ADR-029 §1).
      const root = await this.folderHandle(c.handleKey);
      if (!root) return;
      const top: RemoteFolder[] = [];
      if (!path) {
        const manifest = await (root as unknown as FileSystemDirectoryHandle)
          .getFileHandle('wren.project.json')
          .then(
            () => true,
            () => false,
          );
        top.push({ name: `${c.label} (repository root)`, path: '/', isProject: manifest });
      }
      const sub = await this.listFolders(c, path);
      this.patch({
        browse: {
          connectionId,
          connectionLabel: `${c.label} · git`,
          path,
          folders: [...top, ...(sub.ok ? sub.value : [])],
          ...(sub.ok ? {} : { error: errText(sub) }),
        },
      });
      return;
    }
    const r = await this.listFolders(c, path);
    this.patch({
      browse: r.ok
        ? { connectionId, connectionLabel: label, path, folders: r.value }
        : { connectionId, connectionLabel: label, path, folders: [], error: errText(r) },
    });
  }

  private async listFolders(c: Connection, path: string) {
    const p = await this.providerFor(c);
    if (!p.ok) return p;
    return p.value.browse(path);
  }

  private providerFor(c: Connection): Promise<StorageResult<StorageProvider>> {
    return createProvider(c, {
      vault: this.vault,
      oauth: oauthConfig(),
      workerUrl: syncConfig().syncWorkerUrl,
      folderHandle: (key) => this.folderHandle(key),
      fetch: syncFetch,
    });
  }

  /**
   * Folder step: a project folder opens into the library; any other folder links the open
   * project to it (its files are uploaded there).
   */
  async pickFolder(f: { path: string; name: string; isProject: boolean }): Promise<void> {
    const b = this.view.get().browse;
    const c = this.connections.find((x) => x.id === b?.connectionId);
    if (!c) return;
    this.patch({ browse: null, addError: null });
    const path =
      c.kind === 'folder' && c.git ? (f.path === '/' ? '' : f.path.replace(/^\//, '')) : f.path;
    const link: ProjectLink = { connectionId: c.id, path };
    this.patchProject({ busy: f.isProject ? 'Opening the project…' : 'Linking the project…' });
    try {
      if (f.isProject) await this.openRemote(c, link);
      else await this.linkCurrent(link);
    } finally {
      this.patchProject({ busy: null });
    }
    await this.refreshConnections();
  }

  private async linkCurrent(link: ProjectLink): Promise<void> {
    await this.host.persist();
    const id = this.host.currentId();
    if (!id) return;
    const c = this.connections.find((x) => x.id === link.connectionId);
    if (c && GIT_KINDS.has(c.kind)) {
      // An empty repository: the first version is committed and pushed now.
      setLink(id, link);
      await this.openProject(id);
      const h = this.history as GitHistory | null;
      if (!h) return;
      const cloned = await h.clone();
      if (!cloned.ok) return this.fail(cloned);
      const files = await this.readProject(id);
      if (!files) return;
      const v = await h.saveVersion(files, 'First version from Wren', { author: AUTHOR });
      if (!v.ok) return this.fail(v);
      const pushed = await h.push();
      if (!pushed.ok) return this.fail(pushed);
      await this.refreshHistory();
      this.host.toast('Linked to the repository and pushed the first version.');
      return;
    }
    setLink(id, link);
    await this.openProject(id);
    this.host.toast('Linked: changes now sync in the background.');
  }

  private async openRemote(c: Connection, link: ProjectLink): Promise<void> {
    const id = ulid();
    if (GIT_KINDS.has(c.kind)) {
      // The clone's browser filesystem is named after the new library entry's id.
      const r = await this.gitHostHistory(id, c, link.path).clone();
      if (!r.ok) return this.fail(r);
      setLink(id, link);
      if (await this.openNew(r.value, id)) await this.openProject(id);
      else setLink(id, null);
      return;
    }
    const p = await this.providerFor(c);
    if (!p.ok) return this.fail(p);
    const root = c.kind === 'folder' && c.git ? (link.path ? `/${link.path}` : '') : link.path;
    const listing = await p.value.list({ path: root });
    if (!listing.ok) return this.fail(listing);
    const files: ProjectFiles = new Map();
    const prefix = `${root.replace(/\/+$/, '')}/`.toLowerCase();
    for (const e of listing.value.entries) {
      if (e.kind !== 'file') continue;
      const rel = e.path.toLowerCase().startsWith(prefix) ? e.path.slice(prefix.length) : null;
      // Same rules as the sync engine: no cache, no .git, no `..` or absolute paths (gate N5).
      if (!rel || !syncable(rel)) continue;
      const r = await p.value.read(e.path);
      if (!r.ok) return this.fail(r);
      files.set(rel, r.value.bytes);
    }
    setLink(id, link);
    if (await this.openNew(files, id)) await this.openProject(id);
    else setLink(id, null);
  }

  private gitHostHistory(dbId: string, c: Connection, url: string) {
    return createGitHistory({
      fs: browserGitFs(dbId),
      http: browserGitHttp,
      dir: '/repo',
      url,
      host: gitHost(c.kind),
      credentials: () => this.vault.get(c.id),
      corsProxy: syncConfig().gitCorsProxy || null,
      author: AUTHOR,
    });
  }

  /**
   * A refused operation, inline. `READ_ONLY` (a merge or rebase in progress, a detached HEAD…)
   * explains itself; `CONFLICT` means something changed outside Wren meanwhile (a file edited
   * on disk, another git committing), so it offers "Refresh" to re-read the repo and sync first.
   */
  private fail(r: { ok: false; error: { code?: string; message: string } }): void {
    const conflict = r.error.code === 'CONFLICT';
    this.patchProject({
      notice:
        r.error.code === 'READ_ONLY'
          ? `Read-only right now: ${errText(r)}`
          : conflict
            ? `${errText(r)} Refresh to pick up what changed, then try again.`
            : errText(r),
      noticeAction: conflict ? 'refresh' : null,
    });
    if (!conflict && r.error.code !== 'READ_ONLY') this.host.toast(errText(r), 'error');
  }

  /** "Refresh" after a `CONFLICT`: re-read the repo, bring outside edits in, re-list. */
  async refreshRepo(): Promise<void> {
    (this.history as { refresh?: () => void } | null)?.refresh?.();
    if (this.engine) await this.engine.syncNow();
    this.patchProject({ notice: null, noticeAction: null });
    await this.refreshHistory();
  }

  /** A new, empty project folder inside the folder being browsed (then link the project to it). */
  async createProjectFolder(name: string): Promise<void> {
    const b = this.view.get().browse;
    const c = this.connections.find((x) => x.id === b?.connectionId);
    if (!b || c?.kind !== 'folder') return;
    const slug = slugify(name.trim(), 'project');
    let d = (await this.folderHandle(c.handleKey)) as unknown as FileSystemDirectoryHandle | null;
    if (!d) return;
    try {
      for (const s of b.path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(s);
      await d.getDirectoryHandle(slug, { create: true });
    } catch (e) {
      this.patch({ addError: `Couldn’t create ‘${slug}’: ${e instanceof Error ? e.message : e}` });
      return;
    }
    const path = `${b.path.replace(/\/+$/, '')}/${slug}`;
    await this.pickFolder({ path, name: slug, isProject: false });
  }

  // ---------------------------------------------------------------- working copy

  /** The library entry's working copy (document files + extra), or null when it has none. */
  readProject(id: string): Promise<ProjectFiles | null> {
    return this.host
      .lockLibrary(async (lib) => {
        const b = await lib.find(id);
        return b ? projectFiles(b.doc, b.extra) : null;
      })
      .then((f) => f ?? null);
  }

  /** `SyncLocalStore.writeFiles`: compare-and-swap on the library entry, atomic with saves. */
  writeProject(
    id: string,
    changes: ReadonlyMap<string, Uint8Array | null>,
    expected: ReadonlyMap<string, Uint8Array | null>,
  ): Promise<boolean> {
    return this.host
      .lockLibrary(async (lib) => {
        const current = id === this.host.currentId();
        if (current && !this.host.canAdoptRemote()) return false;
        const b = await lib.find(id);
        if (!b) return false;
        const next = applyChanges(projectFiles(b.doc, b.extra), changes, expected);
        if (!next) return false;
        const { doc, extra } = splitProject(next, id);
        await lib.save(doc, { extra, cache: b.cache });
        this.lastFiles.set(id, next);
        if (current) this.host.adoptRemote(doc, extra, patchTo(this.host.doc(), doc, true));
        return true;
      })
      .then((r) => r ?? false);
  }

  /** Files → the open project, as one undoable edit. */
  private applyFiles(files: ProjectFiles, label: string): boolean {
    const id = this.host.currentId() ?? '';
    const { doc, extra } = splitProject(files, id);
    return this.host.applyFiles(extra, label, patchTo(this.host.doc(), doc, false));
  }

  private async openNew(files: ProjectFiles, id: string): Promise<boolean> {
    if (!files.has('wren.project.json')) {
      this.patchProject({ notice: 'That folder has no Wren project (wren.project.json).' });
      return false;
    }
    try {
      const { doc, extra } = splitProject(files, id);
      return await this.host.openNewProject(doc, extra);
    } catch (e) {
      this.patchProject({
        notice: `That project can’t be opened: ${e instanceof Error ? e.message : e}`,
      });
      return false;
    }
  }

  // ---------------------------------------------------------------- the open project

  /** The open document changed (open, new, import). Starts its engine and history. */
  openProject(id: string | null | undefined): Promise<void> {
    this.opening = this.opening.then(() => this.openNow(id ?? null));
    return this.opening;
  }

  private stopEngine(): void {
    this.engineOff?.();
    this.engineOff = null;
    this.engine?.dispose();
    this.engine = null;
  }

  private async openNow(id: string | null): Promise<void> {
    this.closeMode();
    this.stopEngine();
    this.history = null;
    this.localRepo = null;
    this.projectId = id;
    this.link = linkOf(id ?? undefined);
    const c = this.link
      ? this.connections.find((x) => x.id === this.link?.connectionId)
      : undefined;
    let kind: ProjectKind = 'local';
    let linkLabel: string | undefined;
    if (id && this.link && c) {
      if (GIT_KINDS.has(c.kind)) {
        kind = 'git';
        linkLabel = `${c.label} · ${c.kind === 'github' ? 'GitHub' : c.kind}`;
        this.history = this.gitHostHistory(id, c, this.link.path);
      } else {
        kind = c.kind === 'folder' && c.git ? 'localGit' : 'file';
        linkLabel = `${c.label}${this.link.path ? ` · ${this.link.path}` : ''}`;
        await this.startEngine(id, c, this.link);
      }
    }
    // Local git mode never writes `.wren-history/` (ADR-029), even when the folder is gone.
    if (id && !this.history && kind !== 'git' && kind !== 'localGit') {
      this.history = createSnapshotHistory({
        files: this.historyFiles(),
        ...(loadHistoryState(id) ? { state: loadHistoryState(id) } : {}),
        onStateChange: (s) => saveHistoryState(id, s),
      });
    }
    this.patchProject({
      id,
      kind,
      ...(linkLabel ? { linkLabel } : { linkLabel: undefined }),
      status:
        this.engine?.status() ??
        (kind === 'git' ? { state: 'idle', pending: 0 } : { state: 'local' }),
      history: null,
      notice: null,
      saveError: null,
    });
    const files = id ? await this.readProject(id) : null;
    if (id && files) this.lastFiles.set(id, files);
    await this.refreshHistory();
    if (kind === 'git') void this.gitFetchStatus();
  }

  private async startEngine(id: string, c: Connection, link: ProjectLink): Promise<void> {
    let provider: StorageProvider;
    let engineLink = link;
    if (c.kind === 'folder' && c.git) {
      const root = await this.folderHandle(c.handleKey);
      if (!root) {
        this.patchProject({ notice: `Choose the folder ‘${c.label}’ again to reconnect it.` });
        return;
      }
      const repo = await openLocalGit({
        root,
        projectPath: link.path,
        author: AUTHOR,
        corsProxy: syncConfig().gitCorsProxy || null,
        signedIn: (host) => this.signedInTo(host),
      });
      if (!repo.ok) {
        this.patchProject({ notice: errText(repo) });
        return;
      }
      this.localRepo = repo.value;
      this.history = repo.value.history;
      provider = new FolderProvider(root);
      engineLink = { connectionId: c.id, path: link.path ? `/${link.path}` : '' };
    } else {
      const p = await this.providerFor(c);
      if (!p.ok) {
        this.patchProject({ status: { state: 'error', error: p.error } });
        return;
      }
      provider = p.value;
    }
    const engine = createSyncEngine({
      provider,
      link: engineLink,
      merger: docMerger,
      store: createIdbSyncStore(id, {
        readFiles: async () => (await this.readProject(id)) ?? new Map(),
        writeFiles: (changes, expected) => this.writeProject(id, changes, expected),
      }),
    });
    this.engine = engine;
    this.engineOff = engine.subscribe((status) => {
      if (this.engine !== engine) return;
      this.patchProject({ status });
      // Remote changes may carry new versions (`.wren-history/` syncs with the project).
      if (status.state === 'idle') void this.refreshHistory();
    });
  }

  /** A git connection signed in to `host` (a local repo's origin, ADR-029 §4). */
  private signedInTo(host: string) {
    const c = this.connections.find((x) => GIT_KINDS.has(x.kind) && 'host' in x && x.host === host);
    return c ? { host: gitHost(c.kind), credentials: () => this.vault.get(c.id) } : null;
  }

  /** Autosave reached the library: queue the changed paths, maybe take an automatic snapshot. */
  onSaved(id: string, doc: WrenDoc, extra: ProjectFiles): void {
    const files = projectFiles(doc, extra);
    const before = this.lastFiles.get(id);
    this.lastFiles.set(id, files);
    if (id !== this.projectId) return;
    const changed = before ? changedPaths(before, files) : [...files.keys()];
    if (changed.length) this.engine?.notifyLocalChange(changed);
    if (this.view.get().project.kind === 'git') void this.gitFetchStatus(false);
    void this.autoSnapshot(files);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refreshHistory(), 800);
  }

  /** Automatic snapshots every 10 minutes of editing, for projects that already keep versions. */
  private async autoSnapshot(files: ProjectFiles): Promise<void> {
    const h = this.history;
    const view = this.view.get().project.history;
    if (h?.backend !== 'snapshot' || !view || view.versions.length === 0) return;
    const now = Date.now();
    if (now - this.lastAuto < AUTO_EVERY_MS) return;
    this.lastAuto = now;
    const r = await h.saveVersion(files, 'Automatic snapshot', { author: AUTHOR, auto: true });
    if (r.ok && now - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = now;
      await h.prune(DEFAULT_PRUNE_POLICY);
    }
    await this.host.persist();
  }

  private historyFiles(): HistoryFiles {
    const host = this.host;
    return {
      read: async (p) => host.extra().get(p) ?? null,
      write: async (p, b) => host.setExtraFiles(new Map([[p, b]])),
      list: async (prefix) => [...host.extra().keys()].filter((k) => k.startsWith(prefix)),
      remove: async (p) => host.setExtraFiles(new Map([[p, null]])),
    };
  }

  private async onFocus(): Promise<void> {
    const h = this.history as (HistoryStore & { refresh?: () => void }) | null;
    if (this.view.get().project.kind === 'localGit') {
      h?.refresh?.();
      await this.refreshHistory();
    }
  }

  async refreshHistory(): Promise<void> {
    const h = this.history;
    const id = this.projectId;
    if (!h || !id) {
      this.patchProject({ history: null });
      return;
    }
    const kind = this.view.get().project.kind;
    const [versions, branches] = await Promise.all([
      h.log({ includeAuto: true, limit: 200 }),
      h.branches(),
    ]);
    if (this.history !== h) return;
    const current = branches.find((b) => b.current);
    const view: HistoryView = { backend: h.backend, versions, branches, diverged: null };
    // "Current" only while the working copy is exactly that version (same content hash), so a
    // version the user has since edited away from can be compared with what is on screen now.
    const files = await this.readProject(id);
    const wcHash = files ? await hashProjectFiles(versionedFiles(files)) : null;
    const markCurrent = (base: string | null | undefined) => {
      const v = versions.find((x) => x.id === base);
      if (v && v.hash === wcHash) view.currentId = v.id;
    };
    if (h.backend === 'snapshot') {
      const local = (h as unknown as { state(): { version: string | null } }).state();
      markCurrent(local.version);
      const other = branches.find((b) => b.name === current?.name && !b.current);
      if (other)
        view.diverged = {
          theirs: other.head,
          message: `Another device saved versions to ${other.name}.`,
        };
    } else {
      markCurrent(current?.head ?? versions[0]?.id);
      const g = h as GitHistory;
      const repo = this.localRepo;
      if (kind === 'localGit' && repo) {
        const wc = await g.workingChanges();
        view.workingChanges = wc.ok ? wc.value : [];
        view.readOnly = (await repo.state()).readOnly?.message ?? null;
        const ignored = await repo.ensureCacheIgnored();
        view.cacheIgnored = ignored.ok ? ignored.value.ignored : true;
        const remotes = await g.remotes();
        const signedIn =
          (repo as LocalGitRepo & { remoteSignedIn?: boolean }).remoteSignedIn === true;
        view.canPushPull = remotes.length > 0 && signedIn;
        if (!view.canPushPull)
          view.remoteNote =
            remotes.length > 0
              ? 'Push and pull with your own git, or sign in to this repository’s host in Connections.'
              : 'This repository has no remote. Push with your own git when you add one.';
      } else view.canPushPull = true;
    }
    this.patchProject({ history: view });
  }

  /** Git hosts: ahead count after a fetch, shown in the chip. */
  private async gitFetchStatus(fetch = true): Promise<void> {
    const h = this.history as GitHistory | null;
    if (h?.backend !== 'git') return;
    if (!fetch) {
      this.patchProject({ status: { state: 'idle', pending: 0 } });
      return;
    }
    const r = await h.fetch();
    if (this.history !== h) return;
    this.patchProject({
      status: r.ok
        ? { state: 'idle', pending: r.value.ahead, lastSyncAt: new Date().toISOString() }
        : r.error.code === 'OFFLINE'
          ? { state: 'offline', pending: 0 }
          : { state: 'error', error: r.error },
    });
  }

  // ---------------------------------------------------------------- versions

  private async currentFiles(): Promise<ProjectFiles | null> {
    await this.host.persist();
    const id = this.host.currentId();
    return id ? this.readProject(id) : null;
  }

  private readOnlyReason(): string | null {
    return this.view.get().project.history?.readOnly ?? null;
  }

  async saveVersion(message: string): Promise<void> {
    const h = this.history;
    if (!h) return;
    const ro = this.readOnlyReason();
    if (ro) {
      this.patchProject({ saveError: ro });
      throw new Error(ro);
    }
    this.patchProject({ saving: true, saveError: null });
    try {
      // Local git: the disk is the working copy, so it must hold the latest save first.
      if (this.engine) await this.engine.syncNow();
      const files = await this.currentFiles();
      if (!files) throw new Error('Nothing to save yet.');
      const r = await h.saveVersion(files, message, { author: AUTHOR });
      if (!r.ok) {
        this.patchProject({ saveError: errText(r) });
        throw new Error(errText(r));
      }
      if (h.backend === 'snapshot') await this.host.persist();
      await this.refreshHistory();
      if (this.view.get().project.kind === 'git') void this.gitFetchStatus();
    } finally {
      this.patchProject({ saving: false });
    }
  }

  async restore(versionId: string): Promise<void> {
    const h = this.history;
    if (!h) return;
    const r = await h.read(versionId);
    if (!r.ok) return this.fail(r);
    const v = this.view.get().project.history?.versions.find((x) => x.id === versionId);
    const files = this.withHistory(r.value);
    if (this.applyFiles(files, `Restore “${v?.message ?? 'version'}”`))
      this.host.toast('Restored. Undo brings your previous state back.');
  }

  /** Version files plus this working copy's own history (never rolled back by a restore). */
  private withHistory(version: ProjectFiles): ProjectFiles {
    const extra = restoredExtra(this.host.extra(), version);
    const out: ProjectFiles = new Map();
    for (const [p, b] of version) if (!extra.has(p)) out.set(p, b);
    for (const [p, b] of extra) out.set(p, b);
    for (const p of [...out.keys()]) if (p.startsWith('.wren/')) out.delete(p);
    return out;
  }

  private async uncommitted(): Promise<boolean> {
    if (this.view.get().project.kind !== 'localGit') return false;
    if (this.engine) await this.engine.syncNow();
    const wc = await (this.history as GitHistory).workingChanges();
    return wc.ok && wc.value.length > 0;
  }

  async switchBranch(name: string): Promise<void> {
    const h = this.history;
    if (!h) return;
    const ro = this.readOnlyReason();
    if (ro) return void this.patchProject({ notice: ro });
    if (await this.uncommitted()) {
      this.patchProject({
        notice: `The project has uncommitted changes. Save a version first, then switch to ${name}. Nothing was changed.`,
      });
      return;
    }
    if (h.backend === 'snapshot') {
      const files = await this.currentFiles();
      if (files)
        await h.saveVersion(files, `Before switching to ${name}`, { author: AUTHOR, auto: true });
    }
    const r = await h.switchBranch(name);
    if (!r.ok) return this.fail(r);
    if (this.view.get().project.kind === 'localGit') {
      // The checkout rewrote the project folder; sync brings it into the open document.
      await this.engine?.syncNow();
    } else this.applyFiles(this.withHistory(r.value), `Switch to ${name}`);
    if (h.backend === 'snapshot') await this.host.persist();
    this.patchProject({ notice: null });
    await this.refreshHistory();
  }

  async createBranch(name: string): Promise<void> {
    const h = this.history;
    if (!h) return;
    if (
      h.backend === 'snapshot' &&
      !(this.view.get().project.history?.versions ?? []).some((v) => !v.auto)
    ) {
      const files = await this.currentFiles();
      if (files) await h.saveVersion(files, `Before trying ${name}`, { author: AUTHOR });
    }
    const r = await h.createBranch(name);
    if (!r.ok) return this.fail(r);
    await this.switchBranch(name);
  }

  /** Freezes a STEP export (AP214 for now; PDF drawings arrive in M4) into `releases/<slug>/`. */
  async release(versionId: string, name: string): Promise<void> {
    const h = this.history;
    if (!h) return;
    const view = this.view.get().project.history;
    const files = await this.currentFiles();
    const v = view?.versions.find((x) => x.id === versionId);
    const head = await h.saveVersion(files ?? new Map(), 'Release', { author: AUTHOR, auto: true });
    if (!files || !v || !head.ok || head.value.hash !== v.hash) {
      this.patchProject({
        notice:
          'Restore this version (with no edits since) to release it: the release freezes what the model is now.',
      });
      return;
    }
    const modeling = await this.host.modeling();
    const part = this.host.doc().parts[0];
    if (!modeling || !part)
      return void this.patchProject({
        notice: 'The geometry kernel is needed to export the release.',
      });
    const step = await modeling.exportPart(part.id, 'step', { stepSchema: 'AP214' });
    if (!step.ok) return void this.patchProject({ notice: step.error.message });
    const exports: ProjectFiles = new Map([[`${slugify(part.name, 'part')}.step`, step.bytes]]);
    const r = await h.release(versionId, name, exports, AUTHOR);
    if (!r.ok) return this.fail(r);
    if (h.backend === 'snapshot') await this.host.persist();
    else if (this.engine) await this.engine.syncNow();
    this.host.toast(`${name} released: ${r.value.files.join(', ')}`);
    await this.refreshHistory();
  }

  async addCacheToGitignore(): Promise<void> {
    const repo = this.localRepo;
    if (!repo) return;
    const r = await repo.ensureCacheIgnored({ add: true });
    if (!r.ok) this.fail(r);
    // The engine brings the edited .gitignore (a project file at the root) into the library.
    await this.engine?.syncNow();
    await this.refreshHistory();
  }

  async push(): Promise<void> {
    const h = this.history as GitHistory | null;
    if (h?.backend !== 'git') return;
    this.patchProject({ busy: 'Pushing…', notice: null });
    try {
      const r = await h.push();
      if (!r.ok) return this.fail(r);
      if (r.value.kind === 'rejected')
        return void this.patchProject({
          notice:
            r.value.reason === 'behind'
              ? 'The repository has newer commits: pull first.'
              : 'That branch is protected.',
        });
      this.host.toast('Pushed.');
      await this.gitFetchStatus();
    } finally {
      this.patchProject({ busy: null });
    }
  }

  async pull(): Promise<void> {
    const h = this.history as GitHistory | null;
    if (h?.backend !== 'git') return;
    if (await this.uncommitted())
      return void this.patchProject({
        notice: 'The project has uncommitted changes. Save a version first, then pull.',
      });
    this.patchProject({ busy: 'Pulling…', notice: null });
    try {
      const r = await h.pull();
      if (!r.ok) return this.fail(r);
      const local = this.view.get().project.kind === 'localGit';
      if (r.value.kind === 'fastForward' || r.value.kind === 'merged') {
        if (local) await this.engine?.syncNow();
        else this.applyFiles(this.withHistory(r.value.files), 'Pull');
      } else if (r.value.kind === 'conflicts') {
        const { merge, theirs } = r.value;
        const ours = this.view.get().project.history?.currentId;
        this.openMerge(merge, 'This device', 'The repository', async (res) => {
          const files = resolveProjectFiles(merge, res);
          if (!ours) return { ok: false, error: { code: 'REMOTE', message: 'No current version' } };
          const v = await h.commitMerge(files, 'Merge', [ours, theirs], AUTHOR);
          if (v.ok) this.applyFiles(this.withHistory(files), 'Merge');
          return v;
        });
      }
      await this.refreshHistory();
      await this.gitFetchStatus();
    } finally {
      this.patchProject({ busy: null });
    }
  }

  /** A branch with two heads after a sync: three-way merge, then the merge panel if needed. */
  async mergeDiverged(theirs: string): Promise<void> {
    const h = this.history;
    const ours = this.view.get().project.history?.currentId;
    if (!h || !ours) return;
    const base = await h.mergeBase(ours, theirs);
    const read = async (id: string | null) => {
      if (!id) return new Map() as ProjectFiles;
      const r = await h.read(id);
      return r.ok ? r.value : (new Map() as ProjectFiles);
    };
    const merged = await mergeProjectFiles(
      await read(base),
      await read(ours),
      await read(theirs),
      docMerger,
    );
    const commit = async (files: ProjectFiles) => {
      const v = await h.commitMerge(files, 'Merge diverged versions', [ours, theirs], AUTHOR);
      if (v.ok) {
        this.applyFiles(this.withHistory(files), 'Merge versions');
        await this.host.persist();
        await this.refreshHistory();
      }
      return v;
    };
    if (merged.merge.conflicts.length === 0) {
      const v = await commit(merged.files);
      if (!v.ok) this.fail(v);
      else {
        const notes = mergeNotes(merged.merge).map((n) => n.summary);
        this.host.toast(
          [`Merged ${merged.merge.autoMerged} change(s) automatically.`, ...notes].join(' '),
        );
      }
      return;
    }
    this.openMerge(merged.merge, 'This device', 'Other device', (res) =>
      commit(resolveProjectFiles(merged.merge, res)),
    );
  }

  // ---------------------------------------------------------------- merge panel

  private openMerge(
    result: MergeResult,
    oursLabel: string,
    theirsLabel: string,
    finish: (r: MergeResolution[]) => Promise<StorageResult<unknown>>,
  ): void {
    this.closeMode();
    this.mergeFinish = finish;
    this.patch({
      mode: { kind: 'merge', result, resolutions: [], oursLabel, theirsLabel, finishing: false },
    });
    this.host.openPanel('versions');
  }

  /** The chip's "Resolve": sync conflicts in the merge panel. */
  openSyncConflicts(): void {
    const s = this.view.get().project.status;
    const engine = this.engine;
    if (s.state !== 'conflicts' || !engine) return;
    this.openMerge(s.merge, 'This device', 'Another device', (res) => engine.resolve(res));
  }

  setResolution(r: MergeResolution): void {
    const m = this.view.get().mode;
    if (m?.kind !== 'merge') return;
    const rest = m.resolutions.filter((x) => x.conflictId !== r.conflictId);
    this.patch({ mode: { ...m, resolutions: [...rest, r] } });
  }

  unresolve(conflictId: string): void {
    const m = this.view.get().mode;
    if (m?.kind !== 'merge') return;
    this.patch({
      mode: { ...m, resolutions: m.resolutions.filter((x) => x.conflictId !== conflictId) },
    });
  }

  async finishMerge(): Promise<void> {
    const m = this.view.get().mode;
    if (m?.kind !== 'merge' || !this.mergeFinish) return;
    this.patch({ mode: { ...m, finishing: true } });
    const r = await this.mergeFinish(m.resolutions);
    if (!r.ok) {
      this.patch({ mode: { ...m, finishing: false, error: errText(r) } });
      return;
    }
    this.closeMode();
    this.host.toast('Merged. Nothing was lost: every choice is in the history.');
  }

  /** "3D preview of each choice": the choice regenerated in a version slot, diffed against now. */
  async preview(conflictId: string, choice: MergeChoice): Promise<void> {
    const m = this.view.get().mode;
    if (m?.kind !== 'merge') return;
    const res: MergeResolution =
      typeof choice === 'string'
        ? { conflictId, take: choice }
        : { conflictId, value: choice.value };
    const docIds = new Set(m.result.conflicts.filter((c) => !c.file).map((c) => c.id));
    let doc: WrenDoc;
    try {
      doc = docMerger.resolve(
        m.result,
        [...m.resolutions.filter((x) => x.conflictId !== conflictId), res].filter((x) =>
          docIds.has(x.conflictId),
        ),
      );
    } catch (e) {
      this.patch({ mode: { ...m, error: e instanceof Error ? e.message : String(e) } });
      return;
    }
    await this.showDiff(doc, PREVIEW_SLOT, 'both');
  }

  // ---------------------------------------------------------------- compare

  /** Regenerates `doc` in `slot` and overlays its difference from the live model (A = doc). */
  private async showDiff(
    doc: WrenDoc,
    slot: RegenSlot,
    show: CompareMode['overlay'],
  ): Promise<GeometricDiff | null> {
    const modeling = await this.host.modeling();
    const part = this.host.doc().parts[0];
    const port = modeling?.port;
    if (!port?.compare || !part || !doc.parts.some((p) => p.id === part.id)) return null;
    const quality: MeshQuality = 'fine';
    // Compare what is on screen: the version in the same configuration as the live model (M3.7).
    const active = part.activeConfigurationId;
    const other = doc.parts.find((p) => p.id === part.id);
    const shown =
      active && other?.configurations?.some((c) => c.id === active)
        ? resolveConfiguration(doc, part.id, active).doc
        : doc;
    await port.regenerate({
      doc: shown,
      partId: part.id,
      quality,
      slot,
      massProperties: true,
      attachments: this.host.attachments(doc),
    });
    this.compareSlot = { partId: part.id, slot };
    const r = await port.compare(part.id, slot, 'main', quality);
    if (!r.ok) return null;
    this.setOverlay(r.value, show);
    (
      this.host.viewport() as {
        fitAll?: (a: boolean, o: { includeOverlay: boolean }) => void;
      } | null
    )?.fitAll?.(true, { includeOverlay: true });
    return r.value;
  }

  private setOverlay(g: GeometricDiff | null, show: CompareMode['overlay']): void {
    const v = this.host.viewport() as
      | (TouchViewport & { setCompare?: (o: unknown) => void })
      | null;
    v?.setCompare?.(g ? { added: g.added, removed: g.removed, show } : null);
  }

  async compareWith(versionId: string): Promise<void> {
    const h = this.history;
    if (!h) return;
    const v = this.view.get().project.history?.versions.find((x) => x.id === versionId);
    const r = await h.read(versionId);
    if (!r.ok) return this.fail(r);
    let before: WrenDoc;
    try {
      before = splitProject(r.value, this.host.currentId() ?? '').doc;
    } catch {
      return void this.patchProject({ notice: 'That version can’t be read.' });
    }
    this.closeMode();
    const mode: CompareMode = {
      kind: 'compare',
      versionId,
      beforeLabel: v?.message ?? 'Version',
      changes: docDiffer.diff(before, this.host.doc()),
      geometry: null,
      state: 'loading',
      overlay: 'both',
    };
    this.patch({ mode });
    const g = await this.showDiff(before, `version:${versionId}`, 'both');
    const now = this.view.get().mode;
    if (now?.kind !== 'compare' || now.versionId !== versionId) return;
    this.patch({ mode: { ...now, geometry: g, state: g ? 'ready' : 'unavailable' } });
  }

  setCompareOverlay(overlay: CompareMode['overlay']): void {
    const m = this.view.get().mode;
    if (m?.kind !== 'compare') return;
    this.patch({ mode: { ...m, overlay } });
    this.setOverlay(m.geometry, overlay);
  }

  /** Leaves compare or merge: the overlay goes and the version slot's shapes are released. */
  closeMode(): void {
    const slot = this.compareSlot;
    this.compareSlot = null;
    this.mergeFinish = null;
    if (this.view.get().mode) this.patch({ mode: null });
    this.setOverlay(null, 'both');
    if (slot)
      void this.host
        .modeling()
        .then((m) => m?.port.closePart(slot.partId, slot.slot).catch(() => undefined));
  }

  // ---------------------------------------------------------------- test hooks

  async testState() {
    const v = this.view.get();
    const m = v.mode;
    return {
      kind: v.project.kind,
      currentId: v.project.history?.currentId ?? null,
      status: v.project.status.state,
      link: this.link,
      connections: this.connections.map((c) => ({ id: c.id, kind: c.kind, label: c.label })),
      versions:
        v.project.history?.versions.map((x) => ({
          id: x.id,
          message: x.message,
          auto: !!x.auto,
          releases: x.releases ?? [],
        })) ?? [],
      branches: v.project.history?.branches ?? [],
      workingChanges: v.project.history?.workingChanges ?? null,
      compare:
        m?.kind === 'compare' && m.geometry
          ? {
              addedVolume: m.geometry.addedVolume,
              removedVolume: m.geometry.removedVolume,
              added: m.geometry.added.length,
              removed: m.geometry.removed.length,
            }
          : null,
      conflicts: m?.kind === 'merge' ? m.result.conflicts.map((c) => c.path) : null,
      notice: v.project.notice,
      history: this.history ? this.history.backend : null,
      historyFiles: [...this.host.extra().keys()].filter((k) => k.startsWith(HISTORY_PREFIX))
        .length,
    };
  }

  /** Engine and history settled (tests). */
  async idle(): Promise<void> {
    await this.opening;
    await this.engine?.idle();
  }

  /** Sync now (the chip's retry, tests). */
  syncNow(): Promise<unknown> {
    return this.engine ? this.engine.syncNow() : this.gitFetchStatus();
  }

  restorePlace(): { doc: string | null; tab: PanelTab } | null {
    try {
      const raw = sessionStorage.getItem(PLACE_KEY);
      sessionStorage.removeItem(PLACE_KEY);
      return raw ? (JSON.parse(raw) as { doc: string | null; tab: PanelTab }) : null;
    } catch {
      return null;
    }
  }
}

export function createSyncController(host: SyncHost): SyncController {
  return new SyncController(host);
}
