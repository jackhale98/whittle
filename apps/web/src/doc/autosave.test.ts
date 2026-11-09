import type { WrenDoc } from '@wren-cad/contracts';
import { newDoc } from '@wren-cad/document';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosaver } from './autosave';

const named = (name: string): WrenDoc => ({ ...newDoc(), meta: { ...newDoc().meta, name } });

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces: saves the latest document once edits settle for 500 ms', async () => {
    const saved: string[] = [];
    const a = createAutosaver({ save: async (d) => void saved.push(d.meta.name) });
    a.schedule(named('a'));
    await vi.advanceTimersByTimeAsync(300);
    a.schedule(named('b'));
    await vi.advanceTimersByTimeAsync(300);
    a.schedule(named('c'));
    expect(saved).toEqual([]);
    expect(a.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual(['c']);
    expect(a.pending).toBe(false);
  });

  it('flush saves immediately (page hidden) and never runs two saves at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const saved: string[] = [];
    const a = createAutosaver({
      save: async (d) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        saved.push(d.meta.name);
        inFlight--;
      },
    });
    a.schedule(named('x'));
    const f1 = a.flush();
    a.schedule(named('y'));
    const f2 = a.flush();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([f1, f2]);
    expect(saved).toEqual(['x', 'y']);
    expect(maxInFlight).toBe(1);
  });

  it('a failed save is retried with the next flush', async () => {
    let fail = true;
    const saved: string[] = [];
    const errors: unknown[] = [];
    const a = createAutosaver({
      save: async (d) => {
        if (fail) throw new Error('quota');
        saved.push(d.meta.name);
      },
      onError: (e) => errors.push(e),
    });
    a.schedule(named('z'));
    await a.flush();
    expect(errors).toHaveLength(1);
    expect(a.pending).toBe(true);
    fail = false;
    await a.flush();
    expect(saved).toEqual(['z']);
  });
});
