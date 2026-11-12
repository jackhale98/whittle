/**
 * 3D mouse service (M4.5, ADR-096): owns the lazily created `MotionInput` and feeds the viewport.
 *
 * - The WebHID adapter lives in `@wren-cad/viewport` and is imported dynamically (`motion-impl.ts`),
 *   after the first paint and only when the browser has WebHID, so the initial route does not pay
 *   for it. Without WebHID (Safari, Firefox, iPad) nothing is loaded; the state is `unsupported`.
 * - Samples go to `viewport.motion`; button presses go to `onButton` listeners. The keymap binds
 *   them to `MotionButtonCommand`s (the UI layer subscribes; this service has no opinion).
 * - The UI reads everything from `wb.motion` (an app service on the workbench, like `wb.camera`):
 *   `state` (observable, `useObservable(wb.motion.state)`, about 10 Hz while live), `available`,
 *   `pair()`, `setSettings()`, `onButton()`.
 * - Test seam: `window.__wrenHid`, when present, is used instead of `navigator.hid` (E2E injects a
 *   fake device whose reports go through the real parser).
 *
 * Kept small on purpose: this file is in the initial route.
 */

import type {
  MotionInputState,
  MotionSettings,
  TouchViewport,
} from '@wren-cad/contracts';
import type { HIDLike, MotionInput } from '@wren-cad/viewport';
import { observable } from './observable';

/** Where a test (or a policy-restricted embedding) can substitute the WebHID object. */
export function currentHid(): HIDLike | undefined {
  const w = globalThis as { __wrenHid?: HIDLike; navigator?: { hid?: HIDLike } };
  return w.__wrenHid ?? w.navigator?.hid ?? undefined;
}

export class MotionService {
  /** What the diagnostics panel shows. Starts as `unsupported` or `notPaired` without loading code. */
  readonly state = observable<MotionInputState>({
    path: 'none',
    state: currentHid() ? 'notPaired' : 'unsupported',
  });
  private input: Promise<MotionInput | null> | null = null;
  private settings: MotionSettings | null = null;
  private live: MotionInput | null = null;
  private readonly buttons = new Set<(button: number, down: boolean) => void>();
  private disposed = false;

  constructor(private readonly viewport: () => TouchViewport | null) {}

  /** WebHID exists in this browser (the Settings panel hides the pairing button otherwise). */
  get available(): boolean {
    return currentHid() !== undefined;
  }

  /** Loads the adapter when the browser is idle (called once the viewport is ready). */
  start(): void {
    if (!this.available) return;
    const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const run = () => void this.ensure();
    if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 500);
  }

  /** Creates the adapter (loading it on first use). Null without WebHID. */
  ensure(): Promise<MotionInput | null> {
    if (this.disposed || !this.available) return Promise.resolve(null);
    this.input ??= import('./motion-impl')
      .then(({ startMotionInput }) => {
        if (this.disposed) return null;
        const input = startMotionInput({
          viewport: this.viewport,
          hid: currentHid,
          settings: () => this.settings,
          onState: (s) => this.state.set(s),
          onButton: (b, d) => {
            for (const l of [...this.buttons]) l(b, d);
          },
        });
        this.live = input;
        return input;
      })
      .catch(() => {
        this.input = null; // a failed chunk load may be retried by the next pair()
        return null;
      });
    return this.input;
  }

  /** Must run inside a user gesture (the Settings "Pair a 3D mouse" button). */
  async pair(): Promise<void> {
    await (await this.ensure())?.pair();
  }

  /** Per-device settings (sensitivity, inversion...); safe before the adapter has loaded. */
  setSettings(s: MotionSettings): void {
    this.settings = s;
    this.live?.setSettings(s);
  }

  /** 3D mouse button events (1-based), for the keymap binding. */
  onButton(listener: (button: number, down: boolean) => void): () => void {
    this.buttons.add(listener);
    return () => {
      this.buttons.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.live?.dispose();
    this.live = null;
    this.buttons.clear();
  }
}
