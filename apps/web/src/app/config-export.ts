/**
 * Exports of part configurations (M3.7, owner D4): the active configuration, or every
 * configuration with one file each, named by part number (else "<document name>-<configuration
 * name>"). Two configurations that would write the same file are a warning and nothing is
 * written: files are never renamed or overwritten silently.
 */

import type { ExportFormat, Id } from '@wren-cad/contracts';
import { exportFileNames, resolveConfiguration } from '@wren-cad/document';
import type { ExportRequest } from '@wren-cad/ui';
import { activeIdOf, isMissingActive } from './config-model';
import type { Workbench } from './workbench';
import { fileBase } from './workbench-util';

/** The base name (no extension) of the active configuration's export. */
export function exportBase(wb: Workbench): string {
  const part = wb.part;
  if (!part || (!part.configurations?.length && !part.properties?.partNumber)) {
    return fileBase(wb.doc.meta.name);
  }
  const f = exportFileNames(wb.doc, part.id, [activeIdOf(part)]).files[0];
  return f?.fileName ?? fileBase(wb.doc.meta.name);
}

/** A missing active configuration is never exported as if it were Default (trap T2). */
export function refuseMissing(wb: Workbench): boolean {
  if (!isMissingActive(wb.part)) return false;
  wb.toast(
    'This configuration needs attention: it no longer exists. Choose a configuration before exporting.',
    'error',
  );
  return true;
}

/**
 * The active configuration has overrides that no longer apply: it is not exported (the model on
 * screen is a partial one). Same rule as "export all".
 */
export function refuseIssues(wb: Workbench): boolean {
  const issues = wb.config.resolved().issues;
  if (issues.length === 0) return false;
  wb.toast(
    `Not exported: ${wb.config.activeName} needs attention (${issues[0]?.reason}). Fix or reset the override first.`,
    'error',
  );
  return true;
}

const EXT: Record<string, string> = { step: 'step', stl: 'stl', '3mf': '3mf', glb: 'glb' };

/** A plain download (several files in a row cannot each open a save dialog). */
function download(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** "Export all": one file per configuration. */
export async function exportAll(wb: Workbench, request: ExportRequest): Promise<void> {
  const part = wb.part;
  if (!part) return;
  const target = request.target;
  const ext = EXT[target];
  if (!ext) return;
  const doc = wb.doc;
  const ids: (Id | null)[] = [null, ...(part.configurations ?? []).map((c) => c.id)];
  const { files, collisions } = exportFileNames(doc, part.id, ids, `.${ext}`);
  const nameOf = (id: Id | null) =>
    id === null ? 'Default' : (part.configurations?.find((c) => c.id === id)?.name ?? id);
  if (collisions.length > 0) {
    const c = collisions[0];
    wb.toast(
      `Nothing was exported: ${(c?.configurationIds.map(nameOf) ?? []).join(', ')} would both be written to ${c?.fileName}. Give them different part numbers.`,
      'error',
    );
    return;
  }
  const live = wb.regen.get()?.source === 'live' || (await wb.whenLive());
  const modeling = wb.modeling;
  const loop = wb.loop;
  if (!modeling || !loop || !live) return wb.toast('The geometry kernel is still loading.', 'info');
  const lib = await import('../doc/library');
  const skipped: string[] = [];
  const saved: string[] = [];
  let failed: { name: string; message: string } | null = null;
  let written = 0;
  wb.config.setExportingAll(true);
  try {
    await loop.exclusive(async () => {
      for (const f of files) {
        const resolved = resolveConfiguration(doc, part.id, f.configurationId);
        // Overrides that no longer apply: the configuration is partial, so it is never exported.
        if (resolved.issues.length > 0) {
          skipped.push(`${nameOf(f.configurationId)} (${resolved.issues[0]?.reason})`);
          continue;
        }
        try {
          const attachments = Object.fromEntries(
            wb.attachmentsFor(resolved.doc).map((a) => [a.path, a.bytes] as const),
          );
          // The engine exports "the latest regen of main": regenerate this configuration there.
          // The live model is regenerated again when this block ends (value-cached).
          const result = await modeling.port.regenerate({
            doc: resolved.doc,
            partId: part.id,
            quality: 'fine',
            ...(Object.keys(attachments).length ? { attachments } : {}),
          });
          if (result.features.some((s) => s.state === 'error' || s.state === 'needsAttention')) {
            skipped.push(nameOf(f.configurationId));
            continue;
          }
          let bytes: Uint8Array;
          if (target === 'step' || target === 'stl') {
            const r = await modeling.exportPart(part.id, target as ExportFormat, request.options);
            if (!r.ok) {
              skipped.push(nameOf(f.configurationId));
              continue;
            }
            bytes = r.bytes;
          } else {
            const bodies = result.bodies.filter(
              (b) => !request.options.bodies || request.options.bodies.includes(b.id),
            );
            const { meshExporters } = await import('@wren-cad/io');
            const color =
              resolved.doc.parts[0]?.color ?? resolved.doc.parts[0]?.material?.appearance;
            const items = bodies.map((b, i) => ({
              name: `Body ${i + 1}`,
              mesh: b.mesh,
              ...(color ? { color } : {}),
            }));
            bytes =
              target === '3mf'
                ? meshExporters.to3mf(items, 'millimeter')
                : meshExporters.toGlb(items);
          }
          download(bytes, f.fileName, lib.MIME[target as keyof typeof lib.MIME]);
          saved.push(f.fileName);
          written++;
        } catch (e) {
          failed = {
            name: nameOf(f.configurationId),
            message: e instanceof Error ? e.message : String(e),
          };
          return;
        }
      }
    });
  } finally {
    wb.config.setExportingAll(false);
  }
  if (written > 0) wb.exports.set((n) => n + 1);
  const f = failed as { name: string; message: string } | null;
  if (f) {
    wb.toast(
      `Export stopped at ${f.name}: ${f.message}${saved.length ? ` Already saved: ${saved.join(', ')}.` : ''}`,
      'error',
    );
  } else if (skipped.length > 0) {
    wb.toast(
      `Not exported: ${skipped.join(', ')}. ${skipped.length === 1 ? 'It needs' : 'They need'} attention or failed to rebuild.${written ? ` Exported: ${saved.join(', ')}.` : ''}`,
      'error',
    );
  } else wb.toast(`Exported ${written} files, one per configuration.`);
}
