/**
 * Writes preview files of the bracket sheet when WREN_DRAWING_PREVIEW is set to a directory
 * (manual visual check; never in CI). `WREN_DRAWING_PREVIEW=/tmp/x pnpm vitest run preview`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { renderDxfR12, renderDxfR2000 } from '../src/dxf';
import { renderPdf } from '../src/pdf';
import { renderSvg } from '../src/svg';
import { bracketBuild } from './fixtures';

const dir = process.env.WREN_DRAWING_PREVIEW;

describe.skipIf(!dir)('preview', () => {
  it('writes the bracket as PDF, SVG and DXF', () => {
    const build = bracketBuild();
    const sheet = build.sheets[0]!;
    const style = { lineGroup: 'iso-0.5' as const };
    const font = new Uint8Array(
      readFileSync(join(__dirname, '../assets/fonts/osifont-lgpl3fe.ttf')),
    );
    writeFileSync(
      join(dir as string, 'bracket.pdf'),
      renderPdf([{ list: sheet.list, style }], { font, title: 'Bracket' }),
    );
    writeFileSync(
      join(dir as string, 'bracket.svg'),
      renderSvg(sheet.list, style, { paper: '#fff' }),
    );
    writeFileSync(join(dir as string, 'bracket-r12.dxf'), renderDxfR12(sheet.list, style));
    writeFileSync(join(dir as string, 'bracket-r2000.dxf'), renderDxfR2000(sheet.list, style));
  });
});
