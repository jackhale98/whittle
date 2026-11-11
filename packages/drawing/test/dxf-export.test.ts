/**
 * Writes real exports from the drawing package for the interop script (`pnpm --filter
 * @wren-cad/drawing dxf:interop`, ADR-091 amendment). A no-op unless WREN_DXF_EXPORT_DIR is set.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDxfR12, renderDxfR2000 } from '../src/dxf';
import { bracketBuild } from './fixtures';

const OUT = process.env.WREN_DXF_EXPORT_DIR;

describe.skipIf(!OUT)('export fixtures for the interop script', () => {
  it('writes the bracket sheet as R12 and R2000', () => {
    const dir = OUT as string;
    mkdirSync(dir, { recursive: true });
    const sheet = bracketBuild().sheets[0]!;
    const style = { lineGroup: 'iso-0.5' as const };
    const r12 = renderDxfR12(sheet.list, style);
    const r2000 = renderDxfR2000(sheet.list, style);
    writeFileSync(join(dir, 'export-r12.dxf'), r12);
    writeFileSync(join(dir, 'export-r2000.dxf'), r2000);
    expect(r12.length).toBeGreaterThan(0);
    expect(r2000.length).toBeGreaterThan(0);
  });
});
