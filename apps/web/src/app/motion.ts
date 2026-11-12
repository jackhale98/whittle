/**
 * 3D mouse service (M4.5, ADR-096): owns the lazily created `MotionInput` and feeds the viewport.
 *
 * - The WebHID adapter lives in `@wren-cad/viewport` and is imported dynamically, after the first
 *   paint and only when the browser has WebHID, so the initial route does not pay for it. Without
 *   WebHID (Safari, Firefox, iPad) nothing is loaded and the state is `unsupported`.
 * - Samples go to `viewport.motion`; button presses go to `onButton` listeners. The keymap binds
 *   them to `MotionButtonCommand`s (the UI layer subscribes; this service has no opinion).
 * - The UI reads everything from `wb.motion` (an app service on the workbench, like `wb.camera`):
 *   `state` (observable, `useObservable(wb.motion.state)`, about 10 Hz while live), `pair()`,
 *   `setSettings()`, `onButton()`.
 * - Test seam: `window.__wrenHid`, when present, is used instead of `navigator.hid` (E2E injects a
 *   fake device whose reports go through the real parser).
 */

import type {
  MotionInputState,
  MotionSample,
  MotionSettings,
  TouchViewport,
} from '@wren-cad/contracts';
import { DEFAULT_MOTION_SETTINGS } from '@wren-cad/contracts';
import type { HIDLike, MotionInput } from '@wren-cad/viewport';
import { type Observable, observable } from './observable';

/** Where a test (or a policy-restricted embedding) can substitute the WebHID object. */
export function currentHid(): HIDLike | undefined {
  const w = globalThis as { __wrenHid?: HIDLike; navigator?: { hid?: HIDLike } };
  return w.__wrenHid ?? w.navigator?.hid ?? undefined;
}

export class MotionService {
  /** What the diagnostics panel shows. Starts as `unsupported` or `notPaired` without loading code. */
  readonly state: Observable<MotionInputState>;
  private input: MotionInput | null = null;
  private loading: Promise<MotionInput | null> | null = null;
  private settings: MotionSettings = DEFAULT_MOTION_SETTINGS;
  private readonly buttons = new Set<(button: number, down: boolean) => void>();
  private offState: (() => void) | null = null;
  private idle = 0;
  private disposed = false;
  /** Latest samples and button events seen (diagnostics and tests). */
  samples = 0;

  constructor(private readonly viewport: () => TouchViewport | null) {
    this.state = observable<MotionInputState>({
      path: 'none',
      state: currentHid() ? 'notPaired' : 'unsupported',
    });
  }

  /** WebHID exists in this browser (the Settings panel hides the pairing button otherwise). */
  get available(): boolean {
    return currentHid() !== undefined;
  }

  /**
   * Loads the adapter once the shell has painted and the browser is idle. Called when the viewport
   * is ready; a granted device then reconnects without the user doing anything.
   */
  start(): void {
    if (this.disposed || this.input || this.loading || !this.available) return;
    const run = () => {
      this.idle = 0;
      void this.ensure();
    };
    const ric = (
      globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    ).requestIdleCallback;
    this.idle = ric ? ric(run, { timeout: 2000 }) : (setTimeout(run, 500) as unknown as number);
  }

  /** Creates the adapter (loading it on first use). Null without WebHID. */
  ensure(): Promise<MotionInput | null> {
    if (this.input) return Promise.resolve(this.input);
    if (this.disposed || !this.available) return Promise.resolve(null);
    this.loading ??= import('@wren-cad/viewport')
      .then(({ createMotionInput }) => {
        if (this.disposed) return null;
        const hid = currentHid();
        const input = createMotionInput({
          settings: this.settings,
          onSample: (s) => this.onSample(s),
          onButton: (b, down) => {
            for (const l of [...this.buttons]) l(b, down);
          },
          ...(hid ? { hid } : {}),
        });
        this.input = input;
        this.state.set(input.state());
        this.offState = input.onState((s) => this.state.set(s));
        return input;
      })
      .catch(() => {
        this.loading = null; // a failed chunk load may be retried by the next pair()
        return null;
      });
    return this.loading;
  }

  /** Must run inside a user gesture (the Settings "Pair a 3D mouse" button). */
  async pair(): Promise<void> {
    const input = await this.ensure();
    await input?.pair();
  }

  /** Per-device settings (sensitivity, inversion...); safe before the adapter has loaded. */
  setSettings(s: MotionSettings): void {
    this.settings = s;
    this.input?.setSettings(s);
  }

  /** 3D mouse button events (1-based), for the keymap binding. */
  onButton(listener: (button: number, down: boolean) => void): () => void {
    this.buttons.add(listener);
    return () => {
      this.buttons.delete(listener);
    };
  }

  private onSample(s: MotionSample): void {
    this.samples++;
    this.viewport()?.motion?.(s);
  }

  dispose(): void {
    this.disposed = true;
    const cic = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    if (this.idle) {
      if (cic) cic(this.idle);
      else clearTimeout(this.idle);
      this.idle = 0;
    }
    this.offState?.();
    this.offState = null;
    this.input?.dispose();
    this.input = null;
    this.buttons.clear();
  }
}
