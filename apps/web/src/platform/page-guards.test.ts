import { afterEach, describe, expect, it, vi } from 'vitest';
import { canScroll, installPageGuards } from './page-guards';

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
    uninstall();
  });

  it('is a no-op without a document', () => {
    expect(() => installPageGuards(undefined)()).not.toThrow();
  });
});
