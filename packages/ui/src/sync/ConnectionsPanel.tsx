import type { Connection, Id, ProviderKind, RemoteFolder } from '@wren-cad/contracts';
import {
  ArrowUp,
  Cloud,
  CloudDownload,
  CloudUpload,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  GitMerge,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Plug,
  Plus,
  Server,
  Unplug,
} from 'lucide-react';
import { type ComponentType, type ReactNode, useId, useState } from 'react';
import { Switch } from '../components/controls';
import { Button, cn } from '../components/primitives';
import { Badge, PanelShell, plural, rowBtn, type SyncDensity, TextField } from './shared';

type IconType = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

/** Generic icons only: never brand logos (ADR-020, licensing and trademark). */
export const providerMeta: Record<
  ProviderKind,
  { label: string; Icon: IconType; how: 'device' | 'oauth' | 'webdav' | 'token' }
> = {
  folder: { label: 'Folder on this device', Icon: HardDrive, how: 'device' },
  dropbox: { label: 'Dropbox', Icon: Cloud, how: 'oauth' },
  onedrive: { label: 'OneDrive', Icon: CloudUpload, how: 'oauth' },
  gdrive: { label: 'Google Drive', Icon: CloudDownload, how: 'oauth' },
  webdav: { label: 'WebDAV / Nextcloud', Icon: Server, how: 'webdav' },
  github: { label: 'GitHub', Icon: GitBranch, how: 'token' },
  gitlab: { label: 'GitLab', Icon: GitMerge, how: 'token' },
  bitbucket: { label: 'Bitbucket', Icon: GitFork, how: 'token' },
  forgejo: { label: 'Forgejo / Gitea', Icon: GitBranch, how: 'token' },
};

const providerOrder: ProviderKind[] = [
  'folder',
  'dropbox',
  'onedrive',
  'gdrive',
  'webdav',
  'github',
  'gitlab',
  'bitbucket',
  'forgejo',
];

export type ConnectionHealth = 'connected' | 'signedOut' | 'offline' | 'error';

export interface ConnectionItem {
  connection: Connection;
  health: ConnectionHealth;
  /** Why it is not connected ("The password was refused"). */
  detail?: string;
  /** Projects linked through this connection. */
  projects?: number;
}

export interface ProviderOption {
  kind: ProviderKind;
  /** False when the build has no app key for it: shown disabled with `reason`. */
  available: boolean;
  /** "Dropbox isn't set up in this build." */
  reason?: string;
}

export interface WebDavForm {
  url: string;
  username: string;
  password: string;
  relay: boolean;
}

export interface TokenForm {
  kind: Exclude<ProviderKind, 'folder' | 'dropbox' | 'onedrive' | 'gdrive' | 'webdav'>;
  /** Host for self-hosted services (Forgejo); the default host otherwise. */
  host: string;
  token: string;
  username: string;
  /** The repository: `owner/name` on `host`, or a full HTTPS clone URL. */
  repo: string;
}

/** The folder step of the add flow: the host lists `connection`'s folders at `path`. */
export interface FolderBrowse {
  /** Account or label shown in the heading. */
  connectionLabel: string;
  /** Current location, `''` for the top. */
  path: string;
  /** `null` while loading. */
  folders: readonly RemoteFolder[] | null;
  error?: string;
}

export interface ConnectionsPanelProps {
  connections: readonly ConnectionItem[];
  providers: readonly ProviderOption[];
  /** OAuth providers: open the provider's sign-in; the host later fills `browse` (the callback). */
  onSignIn?(kind: ProviderKind): void;
  /** Local folder: the browser's own directory picker is the whole flow. */
  onAddLocalFolder?(): void;
  onAddWebDav?(form: WebDavForm): void;
  onAddToken?(form: TokenForm): void;
  /** Sign-in is in progress (waiting for the provider's callback) for this provider. */
  signingIn?: ProviderKind | null;
  /** Error from the last attempt (refused token, bad URL), shown in the open step. */
  addError?: string | null;
  /** Folder step; set by the host once the connection works. */
  browse?: FolderBrowse | null;
  onBrowse?(path: string): void;
  onPickFolder?(folder: { path: string; name: string; isProject: boolean }): void;
  /** Cancels the add flow in any step. */
  onCancelAdd?(): void;
  /** Re-sign in to a connection whose credential was refused. */
  onReauth?(id: Id): void;
  onRemove?(id: Id): void;
  /** Open the add flow immediately (used by the harness and tests). */
  defaultAdding?: ProviderKind | 'choose' | null;
  density?: SyncDensity;
  className?: string;
}

function accountOf(c: Connection): string {
  switch (c.kind) {
    case 'folder':
      return 'This device';
    case 'webdav':
      return `${c.username} @ ${c.url.replace(/^https?:\/\//, '')}`;
    case 'onedrive':
      return [c.account, c.driveName].filter(Boolean).join(' · ') || 'OneDrive';
    case 'dropbox':
    case 'gdrive':
      return c.account ?? 'Signed in';
    default:
      return [c.account, c.host].filter(Boolean).join(' @ ');
  }
}

const HEALTH: Record<ConnectionHealth, { label: string; tone: 'success' | 'warning' | 'danger' }> =
  {
    connected: { label: 'Connected', tone: 'success' },
    signedOut: { label: 'Signed out', tone: 'warning' },
    offline: { label: 'Offline', tone: 'warning' },
    error: { label: 'Problem', tone: 'danger' },
  };

const GIT_SCOPES: Record<string, string> = {
  github:
    'Create a fine-grained personal access token limited to the one repository you will use, with Repository permissions: Contents = Read and write, Metadata = Read-only. Nothing else is needed.',
  gitlab:
    'Create a project or personal access token with the write_repository scope (and read_repository). Nothing else is needed.',
  bitbucket:
    'Create a repository access token with Repositories: Read and Write. Nothing else is needed.',
  forgejo:
    'Create an access token with the repository read and write scope. Nothing else is needed.',
};

const DEFAULT_HOST: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  forgejo: '',
};

type Step = { at: 'closed' } | { at: 'choose' } | { at: 'form'; kind: ProviderKind };

/**
 * Connections (PLAN 8A.1). The add flow is inline, never a dialog: choose a provider, sign in
 * (or fill the credentials), browse folders, pick the project folder. The host owns the I/O;
 * this component owns only the fields being typed.
 */
export function ConnectionsPanel({
  connections,
  providers,
  onSignIn,
  onAddLocalFolder,
  onAddWebDav,
  onAddToken,
  signingIn,
  addError,
  browse,
  onBrowse,
  onPickFolder,
  onCancelAdd,
  onReauth,
  onRemove,
  defaultAdding = null,
  density = 'compact',
  className,
}: ConnectionsPanelProps) {
  const [step, setStep] = useState<Step>(
    defaultAdding === null
      ? { at: 'closed' }
      : defaultAdding === 'choose'
        ? { at: 'choose' }
        : { at: 'form', kind: defaultAdding },
  );
  const [confirmRemove, setConfirmRemove] = useState<Id | null>(null);
  const touch = density === 'touch';

  const adding = step.at !== 'closed' || !!browse;
  const cancel = () => {
    setStep({ at: 'closed' });
    onCancelAdd?.();
  };

  function choose(kind: ProviderKind) {
    const how = providerMeta[kind].how;
    if (how === 'device') {
      setStep({ at: 'closed' });
      onAddLocalFolder?.();
    } else if (how === 'oauth') {
      setStep({ at: 'form', kind });
      onSignIn?.(kind);
    } else setStep({ at: 'form', kind });
  }

  return (
    <PanelShell
      title="Connections"
      density={density}
      testId="connections-panel"
      className={className}
      actions={
        !adding ? (
          <Button
            size={touch ? 'touch' : 'md'}
            icon={<Plus className="size-4" aria-hidden />}
            onClick={() => setStep({ at: 'choose' })}
          >
            Add connection
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
        {connections.length === 0 && !adding ? (
          <p className="rounded-control bg-surface-2 p-3 text-ui text-fg-muted">
            Projects live on this device. Connect a cloud drive, a folder, a WebDAV server or a git
            host to back them up and use them on other devices.
          </p>
        ) : null}

        {connections.length > 0 ? (
          <ul aria-label="Connections" className="m-0 flex list-none flex-col gap-2 p-0">
            {connections.map((item) => {
              const c = item.connection;
              const { Icon } = providerMeta[c.kind];
              const h = HEALTH[item.health];
              const needsSignIn = item.health === 'signedOut';
              const confirming = confirmRemove === c.id;
              return (
                <li
                  key={c.id}
                  data-connection-id={c.id}
                  className="flex flex-col gap-2 rounded-control bg-surface-2 p-3"
                >
                  <div className="flex items-start gap-3">
                    <Icon className="mt-0.5 size-5 shrink-0 text-fg-muted" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.label}</p>
                      <p className="truncate text-xs text-fg-muted">
                        {providerMeta[c.kind].label} · {accountOf(c)}
                      </p>
                      {item.detail ? (
                        <p className="mt-1 text-2xs text-fg-muted">{item.detail}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={h.tone}>{h.label}</Badge>
                      {item.projects ? (
                        <span className="text-2xs text-fg-subtle">
                          {plural(item.projects, 'project')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {confirming ? (
                    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
                      <legend className="sr-only">{`Remove ${c.label}`}</legend>
                      <p className="min-w-0 flex-1 text-xs text-fg-muted">
                        Remove {c.label}? Your files stay where they are; projects keep working on
                        this device.
                      </p>
                      <button
                        type="button"
                        // biome-ignore lint/a11y/noAutofocus: focus moves to the inline confirmation
                        autoFocus
                        className={cn(
                          rowBtn(density),
                          'bg-danger-soft text-danger-text shadow-inset',
                        )}
                        onClick={() => {
                          setConfirmRemove(null);
                          onRemove?.(c.id);
                        }}
                      >
                        Remove
                      </button>
                      <Button size={touch ? 'touch' : 'md'} onClick={() => setConfirmRemove(null)}>
                        Keep
                      </Button>
                    </fieldset>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {needsSignIn ? (
                        <Button
                          variant="primary"
                          size={touch ? 'touch' : 'md'}
                          icon={<Plug className="size-4" aria-hidden />}
                          onClick={() => onReauth?.(c.id)}
                        >
                          Sign in again
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size={touch ? 'touch' : 'md'}
                        aria-label={`Remove connection ${c.label}`}
                        icon={<Unplug className="size-4" aria-hidden />}
                        onClick={() => setConfirmRemove(c.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {browse ? (
          <FolderStep
            browse={browse}
            density={density}
            onBrowse={onBrowse}
            onPick={(f) => {
              setStep({ at: 'closed' });
              onPickFolder?.(f);
            }}
            onCancel={cancel}
          />
        ) : step.at === 'choose' ? (
          <ProviderStep
            providers={providers}
            density={density}
            onChoose={choose}
            onCancel={cancel}
          />
        ) : step.at === 'form' ? (
          <FormStep
            kind={step.kind}
            density={density}
            signingIn={signingIn === step.kind}
            error={addError ?? null}
            onSignIn={onSignIn}
            onAddWebDav={onAddWebDav}
            onAddToken={onAddToken}
            onBack={() => setStep({ at: 'choose' })}
            onCancel={cancel}
          />
        ) : null}
      </div>
    </PanelShell>
  );
}

/* ------------------------------------------------------------------------- steps */

function StepFrame({
  title,
  step,
  children,
}: {
  title: string;
  /** "Step 1 of 3". */
  step: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      data-testid="add-connection"
      className="flex flex-col gap-3 rounded-control bg-surface p-3 shadow-card"
    >
      <div>
        <p className="text-2xs font-medium text-fg-subtle">{step}</p>
        <h3 id={id} className="text-sm font-semibold">
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

function ProviderStep({
  providers,
  density,
  onChoose,
  onCancel,
}: {
  providers: readonly ProviderOption[];
  density: SyncDensity;
  onChoose(kind: ProviderKind): void;
  onCancel(): void;
}) {
  const touch = density === 'touch';
  const byKind = new Map(providers.map((p) => [p.kind, p]));
  const kinds = providerOrder.filter((k) => byKind.has(k));
  return (
    <StepFrame title="Where should this project live?" step="Step 1 of 3 · Choose a service">
      <ul aria-label="Services" className="m-0 grid list-none grid-cols-1 gap-2 p-0">
        {kinds.map((k) => {
          const p = byKind.get(k);
          const { Icon, label } = providerMeta[k];
          const off = !p?.available;
          const reasonId = `reason-${k}`;
          return (
            <li key={k}>
              <button
                type="button"
                aria-disabled={off || undefined}
                aria-describedby={off ? reasonId : undefined}
                onClick={off ? undefined : () => onChoose(k)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-control bg-surface-2 px-3 text-left transition-colors duration-fast',
                  touch ? 'min-h-14' : 'min-h-10',
                  off ? 'cursor-not-allowed opacity-60' : 'hover:bg-surface-3 active:bg-surface-3',
                )}
              >
                <Icon className="size-5 shrink-0 text-fg-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{label}</span>
                  {off ? (
                    <span id={reasonId} className="block text-2xs text-fg-muted">
                      {p?.reason ?? 'Not available in this build.'}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end">
        <Button variant="ghost" size={touch ? 'touch' : 'md'} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </StepFrame>
  );
}

function FormStep({
  kind,
  density,
  signingIn,
  error,
  onSignIn,
  onAddWebDav,
  onAddToken,
  onBack,
  onCancel,
}: {
  kind: ProviderKind;
  density: SyncDensity;
  signingIn: boolean;
  error: string | null;
  onSignIn?(kind: ProviderKind): void;
  onAddWebDav?(form: WebDavForm): void;
  onAddToken?(form: TokenForm): void;
  onBack(): void;
  onCancel(): void;
}) {
  const how = providerMeta[kind].how;
  const touch = density === 'touch';
  const size = touch ? 'touch' : 'md';
  const label = providerMeta[kind].label;
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [relay, setRelay] = useState(false);
  const [host, setHost] = useState(DEFAULT_HOST[kind] ?? '');
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState('');
  const relayId = useId();
  const [tried, setTried] = useState(false);

  const urlError =
    tried && !/^https?:\/\/.+/i.test(url.trim())
      ? 'Enter the full address, starting with https://'
      : null;
  const userError = tried && !username.trim() ? 'Enter your username' : null;
  const passError = tried && !password ? 'Enter an app password' : null;
  const tokenError = tried && !token.trim() ? 'Paste the access token' : null;
  const hostError = tried && !host.trim() ? 'Enter the server address' : null;
  const repoError =
    tried && !/^(https?:\/\/\S+|[\w.-]+\/[\w./-]+)$/i.test(repo.trim())
      ? 'Enter owner/repository, or the repository’s full address'
      : null;

  const back = (
    <Button variant="ghost" size={size} onClick={onBack}>
      Back
    </Button>
  );
  const cancel = (
    <Button variant="ghost" size={size} onClick={onCancel}>
      Cancel
    </Button>
  );

  if (how === 'oauth') {
    return (
      <StepFrame title={`Sign in to ${label}`} step="Step 2 of 3 · Sign in">
        <p className="text-ui text-fg-muted" aria-live="polite">
          {signingIn
            ? `Finish signing in to ${label} in the window that opened. Wren never sees your password.`
            : `A ${label} sign-in page opens. Wren asks only for access to its own files.`}
        </p>
        {error ? (
          <p role="alert" className="text-xs text-danger-text">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {back}
          <div className="flex gap-2">
            {cancel}
            <Button
              variant="primary"
              size={size}
              disabled={signingIn}
              icon={
                signingIn ? (
                  <LoaderCircle className="w-spinner size-4" aria-hidden />
                ) : (
                  <Plug className="size-4" aria-hidden />
                )
              }
              onClick={() => onSignIn?.(kind)}
            >
              {signingIn ? 'Waiting for sign-in…' : `Sign in to ${label}`}
            </Button>
          </div>
        </div>
      </StepFrame>
    );
  }

  if (how === 'webdav') {
    const valid = /^https?:\/\/.+/i.test(url.trim()) && username.trim() && password;
    return (
      <StepFrame title="Connect a WebDAV server" step="Step 2 of 3 · Server details">
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (valid)
              onAddWebDav?.({ url: url.trim(), username: username.trim(), password, relay });
          }}
        >
          <TextField
            label="Server URL"
            type="url"
            inputMode="url"
            placeholder="https://cloud.example.org/remote.php/dav/files/ann"
            value={url}
            density={density}
            error={urlError}
            onChange={(e) => setUrl(e.target.value)}
          />
          <TextField
            label="Username"
            autoComplete="username"
            value={username}
            density={density}
            error={userError}
            onChange={(e) => setUsername(e.target.value)}
          />
          <TextField
            label="App password"
            type="password"
            autoComplete="off"
            value={password}
            density={density}
            error={passError}
            hint="Create an app password in your server's security settings. Not your main password."
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="flex flex-col gap-1">
            <Switch
              checked={relay}
              onChange={setRelay}
              label="Use relay"
              className={touch ? 'min-h-11' : undefined}
            />
            <p id={relayId} className="text-2xs text-fg-subtle">
              Browsers block requests to servers that don't allow them (CORS). If connecting fails
              with a CORS error, turn this on: the relay forwards your requests without storing
              anything. Leave it off if your server already allows Wren, so nothing passes
              through a third party.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-danger-text">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {back}
            <div className="flex gap-2">
              {cancel}
              <Button type="submit" variant="primary" size={size}>
                Connect
              </Button>
            </div>
          </div>
        </form>
      </StepFrame>
    );
  }

  // Git hosts: access token.
  const gitKind = kind as TokenForm['kind'];
  return (
    <StepFrame title={`Connect ${label}`} step="Step 2 of 3 · Access token">
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          const r = repo.trim();
          const repoOk = /^(https?:\/\/\S+|[\w.-]+\/[\w./-]+)$/i.test(r);
          if (token.trim() && host.trim() && repoOk)
            onAddToken?.({
              kind: gitKind,
              host: host.trim(),
              token: token.trim(),
              username,
              repo: r,
            });
        }}
      >
        <p className="flex gap-2 rounded-control bg-surface-2 p-2.5 text-xs text-fg-muted">
          <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{GIT_SCOPES[kind]}</span>
        </p>
        {kind === 'forgejo' ? (
          <TextField
            label="Server address"
            inputMode="url"
            placeholder="git.example.org"
            value={host}
            density={density}
            error={hostError}
            onChange={(e) => setHost(e.target.value)}
          />
        ) : null}
        <TextField
          label="Repository"
          inputMode="url"
          placeholder={`owner/repository or https://${DEFAULT_HOST[kind] || 'git.example.org'}/owner/repository`}
          value={repo}
          density={density}
          error={repoError}
          onChange={(e) => setRepo(e.target.value)}
        />
        <TextField
          label={kind === 'github' ? 'Fine-grained token' : 'Access token'}
          type="password"
          value={token}
          density={density}
          error={tokenError}
          hint="Stored encrypted on this device. Never synced, never logged."
          onChange={(e) => setToken(e.target.value)}
        />
        {error ? (
          <p role="alert" className="text-xs text-danger-text">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {back}
          <div className="flex gap-2">
            {cancel}
            <Button type="submit" variant="primary" size={size}>
              Connect
            </Button>
          </div>
        </div>
      </form>
    </StepFrame>
  );
}

function FolderStep({
  browse,
  density,
  onBrowse,
  onPick,
  onCancel,
}: {
  browse: FolderBrowse;
  density: SyncDensity;
  onBrowse?(path: string): void;
  onPick(folder: { path: string; name: string; isProject: boolean }): void;
  onCancel(): void;
}) {
  const touch = density === 'touch';
  const size = touch ? 'touch' : 'md';
  const parent = browse.path.includes('/')
    ? browse.path.slice(0, browse.path.lastIndexOf('/'))
    : '';
  const here = browse.path || '/';
  const name = browse.path.split('/').filter(Boolean).pop() ?? browse.connectionLabel;
  return (
    <StepFrame title="Pick the project folder" step="Step 3 of 3 · Choose a folder">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size={size}
          aria-label="Up one folder"
          disabled={!browse.path}
          icon={<ArrowUp className="size-4" aria-hidden />}
          onClick={() => onBrowse?.(parent)}
        />
        <p className="min-w-0 flex-1 truncate text-xs text-fg-muted" aria-live="polite">
          {browse.connectionLabel} · <span className="font-mono">{here}</span>
        </p>
      </div>
      {browse.error ? (
        <p role="alert" className="text-xs text-danger-text">
          {browse.error}
        </p>
      ) : null}
      {browse.folders === null ? (
        <p role="status" className="flex items-center gap-2 text-ui text-fg-muted">
          <LoaderCircle className="w-spinner size-4" aria-hidden /> Loading folders…
        </p>
      ) : browse.folders.length === 0 ? (
        <p className="text-ui text-fg-muted">No folders here.</p>
      ) : (
        <ul aria-label="Folders" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {browse.folders.map((f) => (
            <li
              key={f.path}
              data-folder-path={f.path}
              className="flex items-center gap-1 rounded-control bg-surface-2"
            >
              <button
                type="button"
                onClick={() => onBrowse?.(f.path)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2.5 rounded-control px-3 text-left hover:bg-surface-3',
                  touch ? 'min-h-11' : 'min-h-9',
                )}
              >
                {f.isProject ? (
                  <FolderOpen className="size-4 shrink-0 text-accent-text" aria-hidden />
                ) : (
                  <Folder className="size-4 shrink-0 text-fg-muted" aria-hidden />
                )}
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-1">
                  <span className="max-w-full truncate text-sm">{f.name}</span>
                  {f.isProject ? <Badge tone="accent">Wren project</Badge> : null}
                </span>
              </button>
              <Button
                variant={f.isProject ? 'primary' : 'secondary'}
                size={size}
                aria-label={`${f.isProject ? 'Open project' : 'Use folder'} ${f.name}`}
                className="mr-1"
                onClick={() => onPick({ path: f.path, name: f.name, isProject: f.isProject })}
              >
                {f.isProject ? 'Open' : 'Use'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size={size} onClick={onCancel}>
          Cancel
        </Button>
        <button
          type="button"
          disabled={!browse.path}
          className={cn(rowBtn(density), 'bg-surface-2 text-fg hover:bg-surface-3')}
          onClick={() => onPick({ path: browse.path, name, isProject: false })}
        >
          Use this folder
        </button>
      </div>
    </StepFrame>
  );
}
