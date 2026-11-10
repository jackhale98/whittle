import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SelectionInspector } from '../src/inspector/SelectionInspector';

describe('SelectionInspector: Clear selection', () => {
  it('has a plain ✕ button named "Clear selection" that calls onClear', async () => {
    const onClear = vi.fn();
    render(<SelectionInspector selection={{ kind: 'face', count: 1 }} onClear={onClear} />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
  it('is absent without a handler', () => {
    render(<SelectionInspector selection={{ kind: 'face', count: 1 }} />);
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();
  });
});
