import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BirdMark, WrenLoader } from '../src';

const css = readFileSync(resolve(import.meta.dirname, '../src/brand/brand.css'), 'utf8');

describe('brand', () => {
  it('the mark is decorative unless labelled, and paints only with theme variables', () => {
    const { container, rerender } = render(<BirdMark />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const fills = [...svg.querySelectorAll('[fill]')].map((el) => el.getAttribute('fill'));
    expect(fills.every((f) => f?.startsWith('var(--'))).toBe(true);
    expect(fills).toContain('var(--wren-accent)'); // the wing follows the app accent
    rerender(<BirdMark label="Wren" />);
    expect(screen.getByRole('img', { name: 'Wren' })).toBeTruthy();
  });

  it('the loader has the block → rough → shaped → finished stages, chips, and a status label', () => {
    render(<WrenLoader label="Loading the modeling kernel" />);
    const svg = screen.getByRole('img', { name: 'Loading the modeling kernel' });
    for (const stage of ['wl-b0', 'wl-b1', 'wl-b2', 'wl-b3', 'wl-bin'])
      expect(svg.querySelector(`.${stage}`)).toBeTruthy();
    expect(svg.querySelectorAll('.wl-chip')).toHaveLength(3);
  });

  it('brand CSS: light and dark palettes for every tone, accent from the theme, reduced motion', () => {
    for (const v of ['--wb-0', '--wb-1', '--wb-2', '--wb-3', '--wb-eye', '--wb-block-front'])
      expect(css.split(`${v}:`).length - 1).toBe(3); // :root, system dark, explicit dark
    expect(css).toContain('--wren-accent: var(--color-accent)');
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.wl-b3 \{[^}]*animation: none/);
  });
});
