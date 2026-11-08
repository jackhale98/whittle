/**
 * Boot timing marks (ms since navigation start) for the M0 "box on screen < 2 s" criterion and the
 * PLAN §10 budgets. Exposed to tests through `window.__whittle.firstBodyRendered()` and
 * `window.__whittleApp.marks()`.
 */
export interface BootTimings {
  shellInteractiveMs: number;
  kernelReadyMs: number;
  firstBodyMs: number;
}

const boot: Partial<BootTimings> = {};
const extra: Record<string, number> = {};
let resolveFirstBody: ((t: BootTimings) => void) | null = null;
let rejectFirstBody: ((err: Error) => void) | null = null;
const firstBody = new Promise<BootTimings>((resolve, reject) => {
  resolveFirstBody = resolve;
  rejectFirstBody = reject;
});
firstBody.catch(() => {}); // observed by tests; avoid unhandled-rejection noise

/** Boot failed (kernel or viewport): tests get the reason instead of a timeout. */
export function failBoot(reason: string): void {
  if (boot.firstBodyMs !== undefined) return;
  rejectFirstBody?.(new Error(reason));
  rejectFirstBody = null;
}

export function mark(name: keyof BootTimings): void {
  if (boot[name] !== undefined) return;
  boot[name] = performance.now();
  performance.mark?.(`whittle:${name}`);
  if (name === 'firstBodyMs' && resolveFirstBody) {
    resolveFirstBody({
      shellInteractiveMs: boot.shellInteractiveMs ?? Number.NaN,
      kernelReadyMs: boot.kernelReadyMs ?? Number.NaN,
      firstBodyMs: boot.firstBodyMs ?? Number.NaN,
    });
  }
}

/** Additional one-shot marks, e.g. `cachedBodyMs` (a cached document's first frame, PLAN §10). */
export function markOnce(name: string): void {
  if (extra[name] !== undefined) return;
  extra[name] = performance.now();
  performance.mark?.(`whittle:${name}`);
}

/** Every mark so far. */
export function marks(): Record<string, number> {
  const out: Record<string, number> = { ...extra };
  for (const [k, v] of Object.entries(boot)) if (v !== undefined) out[k] = v;
  return out;
}

export function firstBodyRendered(): Promise<BootTimings> {
  return firstBody;
}
