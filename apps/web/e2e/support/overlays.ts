import { expect, type Page } from '@playwright/test';

export interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every visible floating overlay's page box. */
export async function overlayBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const sels: Record<string, string> = {
      bubble: '[data-testid="context-bubble"]',
      'section-chip': '[data-testid="section-chip"]',
      'prompt-chip': '[data-testid="prompt-chip"]',
      'extrude-depth': '[data-testid="extrude-depth"]',
      'value-chip': '[data-testid="value-chip"]',
      'sketch-tools': '[aria-label="Sketch tools"]',
      rail: '[aria-label="Modeling tools"]',
      'left-panel': '[data-testid="left-panel"]',
      'right-panel': '[data-testid="right-panel"]',
      toast: '[data-testid="toast"]',
      'view-cube': '[data-testid="view-cube"]',
      'top-bar': '[data-testid="top-bar"]',
      library: '[data-testid="library-button"]',
      sheet: '[data-testid="tools-sheet"]',
    };
    const out: { name: string; x: number; y: number; w: number; h: number }[] = [];
    for (const [name, sel] of Object.entries(sels)) {
      const el = document.querySelector(sel);
      if (!el || (el as HTMLElement).hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ name, x: r.x, y: r.y, w: r.width, h: r.height });
    }
    return out;
  });
}

export function expectNoIntersections(boxes: Box[]) {
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a || !b) continue;
      const hit = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      expect(hit, `${a.name} and ${b.name} overlap`).toBe(false);
    }
}
