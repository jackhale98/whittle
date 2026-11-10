import type { ExportOptions } from '@wren-cad/contracts';

/** Everything the Export menu can produce. `ExportFormat` in contracts covers step/stl/brep only. */
export type ExportTarget = 'step' | 'stl' | '3mf' | 'glb' | 'wren';

export type TessellationQuality = 'coarse' | 'standard' | 'fine';

/** Chord deviation (mm) and angular deflection (rad), matching `ExportOptions` (modeling.ts). */
export const QUALITY_PRESETS: Record<
  TessellationQuality,
  { label: string; linearDeflection: number; angularDeflection: number; hint: string }
> = {
  coarse: { label: 'Coarse', linearDeflection: 0.1, angularDeflection: 0.5, hint: '0.1 mm' },
  standard: { label: 'Standard', linearDeflection: 0.02, angularDeflection: 0.25, hint: '0.02 mm' },
  fine: { label: 'Fine', linearDeflection: 0.005, angularDeflection: 0.1, hint: '0.005 mm' },
};

export interface ExportRequest {
  target: ExportTarget;
  /** Ready to pass to `ModelingApi.exportPart` (for the targets it supports). */
  options: ExportOptions;
  /** The preset behind the deflections, for tessellated targets. */
  quality?: TessellationQuality;
  /**
   * M3.7: which configurations to export. `all` writes one file per configuration (named by part
   * number); absent or `active` is the active one.
   */
  configurations?: 'active' | 'all';
}

/** What the export form says about the part's configurations (M3.7). */
export interface ExportConfigurations {
  /** The active configuration's name. */
  activeName: string;
  /** How many configurations there are, Default included. */
  count: number;
  /** Plain-language collision warnings: files that two configurations would both write. */
  warnings?: readonly string[];
}

export interface ExportBody {
  id: string;
  name: string;
}

export const EXPORT_TARGETS: ReadonlyArray<{
  id: ExportTarget;
  label: string;
  ext: string;
  blurb: string;
}> = [
  { id: 'step', label: 'STEP', ext: '.step', blurb: 'Exact solids for other CAD (AP214)' },
  { id: 'stl', label: 'STL', ext: '.stl', blurb: '3D printing, triangles in mm' },
  { id: '3mf', label: '3MF', ext: '.3mf', blurb: '3D printing with units and colour' },
  { id: 'glb', label: 'GLB', ext: '.glb', blurb: 'Web and AR viewers' },
  { id: 'wren', label: 'Wren project', ext: '.wrencad', blurb: 'Everything, with history' },
];

/** Builds the `ExportRequest` for a set of form choices. */
export function buildExportRequest(c: {
  target: ExportTarget;
  stlBinary: boolean;
  stlPerBody: boolean;
  quality: TessellationQuality;
  bodies?: readonly string[];
  allBodies?: number;
  configurations?: 'active' | 'all';
}): ExportRequest {
  const q = QUALITY_PRESETS[c.quality];
  const options: ExportOptions = {};
  if (c.bodies && c.allBodies !== undefined && c.bodies.length !== c.allBodies) {
    options.bodies = [...c.bodies];
  }
  if (c.target === 'step') options.stepSchema = 'AP214';
  if (c.target === 'stl') {
    options.stlBinary = c.stlBinary;
    options.stlPerBody = c.stlPerBody;
  }
  if (c.target === 'stl' || c.target === '3mf' || c.target === 'glb') {
    options.linearDeflection = q.linearDeflection;
    options.angularDeflection = q.angularDeflection;
    return {
      target: c.target,
      options,
      quality: c.quality,
      ...(c.configurations ? { configurations: c.configurations } : {}),
    };
  }
  return {
    target: c.target,
    options,
    ...(c.configurations ? { configurations: c.configurations } : {}),
  };
}
