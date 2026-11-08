// Ported from Mycelium tests/support/fake-graph.ts (bytes instead of text).
/// A tiny Microsoft Graph for tests: one drive (`d1`) with a folder tree, a change log (delta),
/// uploads with eTags, plus the account and site endpoints.

type Node = { id: string; name: string; eTag: string; folder?: boolean; bytes?: Uint8Array };

export class FakeGraph {
  nodes = new Map<string, Node & { parent: string | null }>();
  changes: Record<string, unknown>[] = [];
  calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  #n = 0;

  constructor() {
    this.nodes.set('root', { id: 'root', name: '', eTag: 'e0', folder: true, parent: null });
  }
  path(id: string): string {
    const n = this.nodes.get(id)!;
    return n.parent === null ? '' : `${this.path(n.parent)}/${n.name}`;
  }
  find(path: string) {
    return [...this.nodes.values()].find(
      (n) => this.path(n.id).toLowerCase() === path.toLowerCase(),
    );
  }
  text(path: string) {
    const b = this.find(path)?.bytes;
    return b ? new TextDecoder().decode(b) : undefined;
  }
  ensureFolder(path: string): string {
    let parent = 'root';
    for (const part of path.split('/').filter(Boolean)) {
      const p = `${this.path(parent)}/${part}`;
      const hit = this.find(p);
      if (hit) parent = hit.id;
      else {
        const id = `f${++this.#n}`;
        this.nodes.set(id, { id, name: part, eTag: `e${this.#n}`, folder: true, parent });
        this.changes.push(this.item(id));
        parent = id;
      }
    }
    return parent;
  }
  put(path: string, content: Uint8Array | string) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const dir = path.slice(0, path.lastIndexOf('/'));
    const parent = this.ensureFolder(dir);
    const existing = this.find(path);
    const id = existing?.id ?? `i${++this.#n}`;
    this.nodes.set(id, {
      id,
      name: path.split('/').pop()!,
      eTag: `"{${id}},${++this.#n}"`,
      bytes,
      parent,
    });
    this.changes.push(this.item(id));
    return this.nodes.get(id)!;
  }
  item(id: string) {
    const n = this.nodes.get(id)!;
    const parentRef =
      n.parent === null
        ? {}
        : { parentReference: { path: `/drive/root:${encodeURI(this.path(n.parent))}` } };
    return {
      id,
      name: n.name,
      eTag: n.eTag,
      ...(n.folder ? { folder: {} } : { file: {}, size: n.bytes?.length ?? 0 }),
      ...(n.parent === null ? { root: {} } : {}),
      ...parentRef,
    };
  }

  fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.calls.push({ method, url: input, headers });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.host === 'download.test') {
      const n = this.nodes.get(url.pathname.slice(1));
      return n?.bytes ? new Response(n.bytes as BodyInit) : new Response(null, { status: 404 });
    }
    const api = url.pathname.replace('/v1.0', '');
    if (api === '/me') return json({ displayName: 'Ada', userPrincipalName: 'ada@contoso.test' });
    if (api === '/me/drive') return json({ id: 'd1', driveType: 'business' });
    if (api === '/sites')
      return json({
        value: [
          { id: 'site1', displayName: 'Team CAD', webUrl: 'https://contoso.test/sites/team' },
        ],
      });
    if (api === '/sites/site1/drives')
      return json({ value: [{ id: 'd1', name: 'Documents', driveType: 'documentLibrary' }] });
    const m = /\/drives\/d1\/root(?::(.*?):)?(?:\/(children|delta|content))?$/.exec(
      decodeURIComponent(url.pathname),
    );
    if (!m) return json({ error: { code: 'nope' } }, 400);
    const [, path = '', action] = m;
    if (action === 'delta') {
      if (url.searchParams.get('token') === 'latest')
        return json({
          value: [],
          '@odata.deltaLink': `https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=${this.changes.length}`,
        });
      const from = Number(url.searchParams.get('token'));
      if (from < 0) return json({ error: { code: 'resyncRequired' } }, 410);
      return json({
        value: this.changes.slice(from),
        '@odata.deltaLink': `https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=${this.changes.length}`,
      });
    }
    const node = path ? this.find(path) : this.nodes.get('root');
    if (action === 'children') {
      if (!node) return json({ error: { code: 'itemNotFound' } }, 404);
      return json({
        value: [...this.nodes.values()]
          .filter((n) => n.parent === node.id)
          .map((n) => this.item(n.id)),
      });
    }
    if (action === 'content' && method === 'PUT') {
      const ifMatch = headers['If-Match'];
      if (ifMatch && !node) return json({ error: { code: 'itemNotFound' } }, 404);
      if (ifMatch && node?.eTag !== ifMatch)
        return json({ error: { code: 'preconditionFailed' } }, 412);
      if (!ifMatch && node && url.search.includes('conflictBehavior=fail'))
        return json({ error: { code: 'nameAlreadyExists' } }, 409);
      const n = this.put(path, (init.body as Uint8Array).slice());
      return json(this.item(n.id));
    }
    if (method === 'DELETE') {
      if (!node) return json({ error: {} }, 404);
      if (headers['If-Match'] && headers['If-Match'] !== node.eTag) return json({ error: {} }, 412);
      const where = this.path(node.parent!);
      this.nodes.delete(node.id);
      this.changes.push({
        id: node.id,
        deleted: {},
        name: node.name,
        parentReference: { path: `/drive/root:${where}` },
      });
      return new Response(null, { status: 204 });
    }
    if (!node) return json({ error: { code: 'itemNotFound' } }, 404);
    return json({
      ...this.item(node.id),
      '@microsoft.graph.downloadUrl': `https://download.test/${node.id}`,
    });
  }) as unknown as typeof fetch;
}
