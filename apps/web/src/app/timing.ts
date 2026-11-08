/**
 * Boot timing marks (ms since navigation start) for the M0 "box on screen < 2 s" criterion and the
 * PLAN §10 budgets. Exposed to tests through `window.__whittle.firstBodyRendered()`.
 */
export interface BootTimings {
  shellInteractiveMs: number;
  kernelReadyMs: number;
  firstBodyMs: number;
}

const marks: Partial<BootTimings> = {};
let resolveFirstBody: ((t: BootTimings) => void) | null = null;
const firstBody = new Promise<BootTimings>((resolve) => {
  resolveFirstBody = resolve;
});

export function mark(name: keyof BootTimings): void {
  if (marks[name] !== undefined) return;
  marks[name] = performance.now();
  performance.mark?.(`whittle:${name}`);
  if (name === 'firstBodyMs' && resolveFirstBody) {
    resolveFirstBody({
      shellInteractiveMs: marks.shellInteractiveMs ?? Number.NaN,
      kernelReadyMs: marks.kernelReadyMs ?? Number.NaN,
      firstBodyMs: marks.firstBodyMs ?? Number.NaN,
    });
  }
}

export function firstBodyRendered(): Promise<BootTimings> {
  return firstBody;
}
