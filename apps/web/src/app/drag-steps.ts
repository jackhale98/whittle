/**
 * Drag steps (sketch geometry drags): one solver step at a time, latest position wins. Moves that
 * arrive while a step runs replace each other; the newest runs next. `finish` stops the run and,
 * on a release, applies the last position that had not run yet: the geometry lands where the
 * pointer was let go, however slow the solver is (review N4: the step loop used to stop at the
 * release, dropping that last move).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export class DragSteps<P> {
  /** A step is running (the solver has not answered yet). */
  inFlight = false;
  /** The running steps; always settles (a failed step ends the run, never hangs it). */
  steps: Promise<void> | null = null;
  /** The newest position that has not run yet. */
  pending: P | null = null;
  private ended = false;

  constructor(private readonly step: (to: P) => Promise<void>) {}

  /** A pointer move: runs now, or replaces the pending position while a step runs. */
  push(to: P): void {
    if (this.ended) return;
    if (this.inFlight) {
      this.pending = to;
      return;
    }
    this.inFlight = true;
    this.steps = (async () => {
      try {
        let next: P | null = to;
        while (next !== null && !this.ended) {
          this.pending = null;
          await this.step(next);
          next = this.pending;
        }
      } catch {
        // A step the solver refused or never answered: the drag keeps what already landed, and
        // `finish` still ends it (an `inFlight` left set used to jam every later edit).
      } finally {
        this.inFlight = false;
      }
    })();
  }

  /**
   * Ends the run once the step in flight has landed. With `flush` (a release), a position still
   * pending then is applied first; without it (a cancel, a pinch taking over) it is dropped.
   * Rejects only if that last step does.
   */
  async finish(flush: boolean): Promise<void> {
    this.ended = true;
    await this.steps;
    const last = this.pending;
    this.pending = null;
    if (flush && last !== null) await this.step(last);
  }
}
