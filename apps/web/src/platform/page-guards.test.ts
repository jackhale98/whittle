import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canScroll, installPageGuards, resetPagePosition } from './page-guards';

const root = resolve(import.meta.dirname, '../..');

function fire(target: EventTarget, type: string, extra: object = {}): Event {
  const e = Object.assign(new Event(type, { cancelable: true }), extra);
  target.dispatchEvent(e);
  return e;
}

interface FakeEl {
  nodeType: 1;
  tagName: string;
  parentElement: FakeEl | null;
  style: { overflowX: string; overflowY: string };
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  matches(sel: string): boolean;
}

function fakeEl(
  tagName: string,
  parentElement: FakeEl | null,
  o: { overflowY?: string; scrollHeight?: number; clientHeight?: number } = {},
): FakeEl {
  return {
    nodeType: 1,
    tagName,
    parentElement,
    style: { overflowX: 'visible', overflowY: o.overflowY ?? 'visible' },
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: o.scrollHeight ?? 0,
    clientHeight: o.clientHeight ?? 0,
    scrollWidth: 0,
    clientWidth: 0,
    matches: (sel) => sel.includes(tagName.toLowerCase()),
  };
}

afterEach(() => vi.unstubAllGlobals());

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

  it('a one-finger drag may only move a panel that can scroll that way, never the page', () => {
    const body = fakeEl('BODY', null);
    const list = fakeEl('DIV', body, { overflowY: 'auto', scrollHeight: 400, clientHeight: 200 });
    const row = fakeEl('DIV', list);
    const grip = fakeEl('DIV', body);
    vi.stubGlobal('getComputedStyle', (el: FakeEl) => el.style);
    const at = (el: FakeEl) => el as unknown as EventTarget;
    // A list at the top: dragging up (content scrolls down) is fine, dragging down is not.
    expect(canScroll(at(row), 0, -30)).toBe(true);
    expect(canScroll(at(row), 0, 30)).toBe(false);
    list.scrollTop = 100;
    expect(canScroll(at(row), 0, 30)).toBe(true);
    // A sheet grip / plain chrome: the page would move, so it is blocked.
    expect(canScroll(at(grip), 0, 40)).toBe(false);
    // Text fields keep caret and selection drags.
    expect(canScroll(at(fakeEl('INPUT', body)), 20, 0)).toBe(true);

    const doc = new EventTarget() as unknown as Document;
    const uninstall = installPageGuards(doc);
    const touch = (y: number) => [{ clientX: 10, clientY: y }];
    fire(doc, 'touchstart', { touches: touch(100) });
    const moved = Object.assign(new Event('touchmove', { cancelable: true }), {
      touches: touch(140),
    });
    Object.defineProperty(moved, 'target', { value: grip });
    doc.dispatchEvent(moved);
    expect(moved.defaultPrevented).toBe(true);

    // An Apple Pencil tap on a button jitters by a pixel or two: never cancelled (iOS would drop
    // the tap's click), but a real Pencil drag on chrome still is.
    const pen = (y: number) => [{ clientX: 10, clientY: y, touchType: 'stylus' }];
    fire(doc, 'touchstart', { touches: pen(100) });
    const jitter = Object.assign(new Event('touchmove', { cancelable: true }), {
      touches: pen(101.5),
    });
    Object.defineProperty(jitter, 'target', { value: grip });
    doc.dispatchEvent(jitter);
    expect(jitter.defaultPrevented).toBe(false);
    const drag = Object.assign(new Event('touchmove', { cancelable: true }), {
      touches: pen(140),
    });
    Object.defineProperty(drag, 'target', { value: grip });
    doc.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    uninstall();
  });

  it('puts the page back where it was once the keyboard has slid it up', () => {
    const scrolled: number[][] = [];
    const root = { scrollTop: 120, scrollLeft: 0 };
    const doc = {
      defaultView: {
        scrollX: 0,
        scrollY: 80,
        scrollTo: (x: number, y: number) => scrolled.push([x, y]),
      },
      scrollingElement: root,
      body: { scrollTop: 0 },
    } as unknown as Document;
    resetPagePosition(doc);
    expect(scrolled).toEqual([[0, 0]]);
    expect(root.scrollTop).toBe(0);
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

  it('brand: adaptive favicon, PNG fallback, and the loader splash shown until React renders', () => {
    expect(html).toContain('href="%BASE_URL%icons/favicon.svg" type="image/svg+xml"');
    expect(html).toContain('href="%BASE_URL%icons/favicon-32.png"');
    // The splash lives inside #root (React's first render replaces it) and follows the system theme.
    expect(html).toMatch(/<div id="root">\s*<div class="boot" role="status"/);
    expect(html).toContain(
      'srcset="%BASE_URL%brand/wren-loader-dark.svg" media="(prefers-color-scheme: dark)"',
    );
    expect(html).toContain('src="%BASE_URL%brand/wren-loader-light.svg"');
    for (const f of [
      'brand/wren-loader-dark.svg',
      'brand/wren-loader-light.svg',
      'icons/favicon.svg',
    ])
      expect(readFileSync(resolve(root, 'public', f), 'utf8')).not.toMatch(
        /<script|https?:\/\/(?!www\.w3\.org)/,
      );
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
