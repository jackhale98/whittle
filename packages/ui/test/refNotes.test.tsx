import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FeatureStatus, FilletFeature } from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import { describeStatus } from '../src/features/featureStatus';
import { RefNotes, refAtPath, refNotesOf } from '../src/inspector/RefNotes';
import { renderUI } from './helpers';

const fillet: FilletFeature = {
  id: 'f1',
  type: 'fillet',
  name: 'Fillet',
  suppressed: false,
  edges: [{ name: 'edge(plateBack|plateLeft)', kind: 'edge' }],
  radius: '2 mm',
};
const grownStatus: FeatureStatus = {
  featureId: 'f1',
  state: 'ok',
  cached: false,
  ms: 1,
  grown: [{ path: '/edges/0', name: 'edge(plateBack|plateLeft)', was: 8, now: 48 }],
};
const mergedStatus: FeatureStatus = {
  featureId: 'f1',
  state: 'ok',
  cached: false,
  ms: 1,
  merged: [{ path: '/edges/0', name: 'edge(a|b)', into: 'edge(a|c)' }],
};

describe('references that changed meaning (M3.8)', () => {
  it('describes a grown ref as a quiet "check this reference", merged as "uses a merged"', () => {
    expect(describeStatus(grownStatus, 'Fillet', () => undefined)).toMatchObject({
      tone: 'muted',
      message: 'Check this reference',
    });
    expect(describeStatus(mergedStatus, 'Fillet', () => undefined)?.message).toMatch(/merged/);
    expect(
      describeStatus(
        { featureId: 'f1', state: 'ok', cached: false, ms: 1 },
        'Fillet',
        () => undefined,
      ),
    ).toBe(null);
  });

  it('lists grown before merged and finds the ref a path points at', () => {
    const both: FeatureStatus = { ...grownStatus, merged: mergedStatus.merged ?? [] };
    expect(refNotesOf(both).map((n) => n.kind)).toEqual(['grown', 'merged']);
    expect(refAtPath(fillet, '/edges/0')?.kind).toBe('edge');
    expect(refAtPath(fillet, '/radius')).toBeNull();
  });

  it('shows old and new size, and Accept / Re-pick call back with the ref', async () => {
    const onAccept = vi.fn();
    const onRepick = vi.fn();
    renderUI(
      <RefNotes feature={fillet} status={grownStatus} onAccept={onAccept} onRepick={onRepick} />,
    );
    expect(screen.getByTestId('ref-note-detail').textContent).toMatch(/8 mm .* 48 mm/);
    await userEvent.click(screen.getByTestId('ref-accept'));
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'grown', path: '/edges/0' }),
    );
    await userEvent.click(screen.getByTestId('ref-repick'));
    expect(onRepick).toHaveBeenCalledWith('/edges/0');
  });

  it('renders nothing when the status has no notes', () => {
    renderUI(
      <RefNotes
        feature={fillet}
        status={{ featureId: 'f1', state: 'ok', cached: false, ms: 1 }}
        onAccept={() => {}}
        onRepick={() => {}}
      />,
    );
    expect(screen.queryByTestId('ref-notes')).toBeNull();
  });
});
