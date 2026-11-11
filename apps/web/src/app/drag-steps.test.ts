import { describe, expect, it } from 'vitest';
import { DragSteps } from './drag-steps';

/** A slow solver stub: each step takes `ms`, and records the positions it applied. */
function slowSolver(ms: number) {
  const applied: number[] = [];
  let calls = 0;
  const step = async (to: number) => {
    calls++;
    await new Promise((r) => setTimeout(r, ms));
    applied.push(to);
  };
  return { applied, step, calls: () => calls };
}

describe('DragSteps (sketch drags, review N4)', () => {
  it('a release applies the last move still waiting for a slow solve', async () => {
    const s = slowSolver(30);
    const d = new DragSteps(s.step);
    d.push(1); // runs
    d.push(2); // pending, replaced by 3
    d.push(3);
    // Released while step 1 is still solving: 3 must land before the drag ends.
    await d.finish(true);
    expect(s.applied).toEqual([1, 3]);
    expect(d.inFlight).toBe(false);
  });

  it('moves while a step runs collapse to the newest; it runs next', async () => {
    const s = slowSolver(10);
    const d = new DragSteps(s.step);
    d.push(1);
    for (let i = 2; i <= 9; i++) d.push(i);
    await d.steps;
    expect(s.applied).toEqual([1, 9]);
    await d.finish(true);
    expect(s.applied).toEqual([1, 9]);
  });

  it('a cancel (no flush) drops the pending move; nothing runs after finish', async () => {
    const s = slowSolver(20);
    const d = new DragSteps(s.step);
    d.push(1);
    d.push(2);
    await d.finish(false);
    d.push(5);
    await d.steps;
    expect(s.applied).toEqual([1]);
    expect(s.calls()).toBe(1);
  });

  it('a step that throws ends the run without jamming; the release still flushes', async () => {
    let n = 0;
    const applied: number[] = [];
    const d = new DragSteps(async (to: number) => {
      n++;
      await new Promise((r) => setTimeout(r, 5));
      if (n === 1) throw new Error('solver restarted');
      applied.push(to);
    });
    d.push(1);
    d.push(2);
    await d.steps;
    expect(d.inFlight).toBe(false);
    d.push(3); // a new run after the failure
    d.push(4);
    await d.finish(true);
    expect(applied).toEqual([3, 4]);
  });
});
