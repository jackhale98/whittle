import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installPageGuards } from './page-guards';

const root = resolve(import.meta.dirname, '../..');

function fire(target: EventTarget, type: string, extra: object = {}): Event {
  const e = Object.assign(new Event(type, { cancelable: true }), extra);
  target.dispatchEvent(e);
  return e;
}

describe('page guards', () => {
  it('cancels the Safari pinch gesture events and multi-touch moves, until uninstalled', () => {
    const doc = new EventTarget() as unknown as Document;
    const uninstall = installPageGuards(doc);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
      expect(fire(doc, type).defaultPrevented).toBe(true);
    expect(fire(doc, 'touchmove', { touches: [{}, {}] }).defaultPrevented).toBe(true);
    // One-finger moves (scrolling panels, drags) are untouched.
    expect(fire(doc, 'touchmove', { touches: [{}] }).defaultPrevented).toBe(false);
    uninstall();
    expect(fire(doc, 'gesturestart').defaultPrevented).toBe(false);
  });

  it('is a no-op without a document', () => {
    expect(() => installPageGuards(undefined)()).not.toThrow();
  });
});

describe('installed-PWA markup', () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const css = readFileSync(resolve(root, 'src/index.css'), 'utf8');

  it('viewport meta: device width, cover, no page zoom', () => {
    const content = html.match(/name="viewport"\s+content="([^"]+)"/)?.[1] ?? '';
    for (const part of [
      'width=device-width',
      'initial-scale=1',
      'viewport-fit=cover',
      'maximum-scale=1',
      'user-scalable=no',
    ])
      expect(content).toContain(part);
  });

  it('iOS standalone meta, icon and light/dark theme colours are present and self-hosted', () => {
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toMatch(/theme-color"[^>]*prefers-color-scheme: light/);
    expect(html).toMatch(/theme-color"[^>]*prefers-color-scheme: dark/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('CSS: touch-action, overscroll, selection, callout, tap highlight, safe-area variables', () => {
    expect(css).toMatch(/html\s*\{[^}]*touch-action:\s*manipulation/);
    expect(css).toMatch(/overscroll-behavior:\s*none/);
    expect(css).toMatch(/-webkit-touch-callout:\s*none/);
    expect(css).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
    expect(css).toMatch(/body\s*\{[^}]*user-select:\s*none/);
    expect(css).toMatch(/input,[\s\S]*?user-select:\s*text/);
    expect(css).toMatch(/canvas\s*\{[^}]*touch-action:\s*none/);
    for (const side of ['top', 'right', 'bottom', 'left'])
      expect(css).toContain(`--safe-${side}: env(safe-area-inset-${side}, 0px)`);
  });
});
