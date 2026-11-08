// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A project inside a repository (local git repo mode, ADR-029): the git working tree is the repo
 * root the user picked, and the project is the folder `ProjectLink.path` inside it. `ProjectScope`
 * maps between repository paths (`cad/bracket/params.json`) and project paths (`params.json`).
 * The empty scope is the whole repository (hosted git connections).
 */

import { gitRefName } from '../names';

/**
 * `/CAD/bracket/` → `CAD/bracket`; `''` or `/` → `''`. Throws for paths that leave the root
 * (`..`) or reach into a git directory: they can never name a project folder.
 */
export function normalizeProjectPath(path: string): string {
  const out: string[] = [];
  for (const s of path.replace(/\\/g, '/').split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..' || s === '.git') throw new Error(`‘${path}’ can't be a project folder`);
    out.push(s);
  }
  return out.join('/');
}

export class ProjectScope {
  /** Repository-relative, no leading or trailing slash; `''` for the repository root. */
  readonly prefix: string;
  readonly segments: readonly string[];
  constructor(projectPath = '') {
    this.prefix = normalizeProjectPath(projectPath);
    this.segments = this.prefix === '' ? [] : this.prefix.split('/');
  }

  get whole(): boolean {
    return this.prefix === '';
  }

  /** Project path → repository path. */
  toRepo(path: string): string {
    return this.prefix === '' ? path : `${this.prefix}/${path}`;
  }

  /** Repository path → project path, or `null` when it's outside the project (or the folder itself). */
  toProject(path: string): string | null {
    if (this.prefix === '') return path;
    return path.startsWith(`${this.prefix}/`) ? path.slice(this.prefix.length + 1) : null;
  }

  /** Inside the project, the project folder itself, or one of the folders leading to it. */
  worthWalking(path: string): boolean {
    if (this.prefix === '' || path === '.' || path === this.prefix) return true;
    return path.startsWith(`${this.prefix}/`) || this.prefix.startsWith(`${path}/`);
  }

  /** Strictly outside the project (and not a folder leading to it). */
  outside(path: string): boolean {
    return !this.worthWalking(path);
  }

  /**
   * Where this project's releases (tags) live: the whole repository's tags for the root project,
   * `<project-path>/` for a project in a subfolder, so two projects can both have a ‘Rev A’.
   */
  get tagPrefix(): string {
    return this.prefix === '' ? '' : `${gitRefName(this.prefix)}/`;
  }
}
