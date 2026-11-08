/**
 * Pointer bookkeeping shared by the workbench and the sketch session. Pure and tiny, so the
 * workbench's eager chunk can import it without pulling in the lazy sketch session.
 */

/** Where and how a pointer went down (client px). */
export interface PointerDown {
  x: number;
  y: number;
  id: number;
  type: string;
}

/**
 * Presses by pointer id. Several pointers can be down at once (a pen and a resting finger, two
 * fingers), so a release is matched to its own press, never to whichever pointer went down last.
 */
export class PointerDowns {
  private readonly downs = new Map<number, PointerDown>();

  press(e: { pointerId: number; clientX: number; clientY: number; pointerType: string }): void {
    this.downs.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      type: e.pointerType,
    });
  }

  /** The press of pointer `id`, removed (null when it went down elsewhere or was dropped). */
  release(id: number): PointerDown | null {
    const d = this.downs.get(id) ?? null;
    this.downs.delete(id);
    return d;
  }

  drop(id: number): void {
    this.downs.delete(id);
  }

  get size(): number {
    return this.downs.size;
  }
}

/**
 * Synthetic `pointerdown`s the sketch session re-dispatches to the canvas so camera navigation
 * learns about a finger the session had withheld (a second finger turned a one-finger draw into a
 * pinch). The workbench and the session ignore these; camera-controls takes them as real.
 */
export const replayedPointerDowns = new WeakSet<Event>();
