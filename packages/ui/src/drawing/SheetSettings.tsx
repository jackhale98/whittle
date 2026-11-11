import type { EvalResult, Id, Projection, SheetFormat } from '@wren-cad/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { Field, Section, Segmented } from '../components/controls';
import { ExpressionInput } from '../components/ExpressionInput';
import { Button, cn } from '../components/primitives';
import { ConfigBadge, type ConfigChoice } from './ViewInspector';

export const SHEET_SIZE_LABELS: Record<string, string> = {
  A0: 'A0 · 841 × 1189 mm',
  A1: 'A1 · 594 × 841 mm',
  A2: 'A2 · 420 × 594 mm',
  A3: 'A3 · 297 × 420 mm',
  A4: 'A4 · 210 × 297 mm',
  'ANSI-A': 'ANSI A · 8.5 × 11 in',
  'ANSI-B': 'ANSI B · 11 × 17 in',
  'ANSI-C': 'ANSI C · 17 × 22 in',
  'ANSI-D': 'ANSI D · 22 × 34 in',
  'ANSI-E': 'ANSI E · 34 × 44 in',
};

export interface SheetSettingsProps {
  drawingName: string;
  onRename(name: string): void;
  family: 'iso' | 'asme';
  gps: string;
  surfaceFinish: string;
  generalTolerance: string;
  onGeneralTolerance(text: string): void;
  projection: Projection;
  onProjection(p: Projection): void;
  sheet: { id: Id; name: string; format: SheetFormat; scale: string };
  sheets: readonly { id: Id; name: string }[];
  onFormat(format: SheetFormat): void;
  onSheetScale(text: string): void;
  evaluateScale(text: string): EvalResult;
  onAddSheet(): void;
  onRemoveSheet(id: Id): void;
  template: { id: string; version: number; latest: number };
  onReapplyTemplate(): void;
  configuration: { value: Id | null; options: readonly ConfigChoice[]; missing?: boolean };
  onConfiguration(value: Id | null): void;
  size?: 'md' | 'touch';
}

/**
 * Drawing and sheet settings. The projection method is explicit and switchable: aligned views
 * follow it with no edits (they are stored relative to their parent). The standard is shown, not
 * silently switched: changing family changes the sheet and style, so it is a new drawing.
 */
export function SheetSettings(p: SheetSettingsProps) {
  const sz = p.size === 'touch' ? 'touch' : 'md';
  const sizeKey = typeof p.sheet.format.size === 'string' ? p.sheet.format.size : 'custom';
  const choices =
    p.family === 'iso'
      ? ['A0', 'A1', 'A2', 'A3', 'A4']
      : ['ANSI-A', 'ANSI-B', 'ANSI-C', 'ANSI-D', 'ANSI-E'];
  const field = cn(
    'rounded-control bg-surface-2 px-2.5 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
    sz === 'touch' ? 'h-11 text-sm' : 'h-8',
  );
  return (
    <div data-testid="sheet-settings" className="flex flex-col">
      <Section title="Drawing">
        <Field label="Name">
          <input
            aria-label="Drawing name"
            defaultValue={p.drawingName}
            key={p.drawingName}
            onBlur={(e) =>
              e.target.value.trim() &&
              e.target.value.trim() !== p.drawingName &&
              p.onRename(e.target.value.trim())
            }
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className={field}
          />
        </Field>
        <Field label="Projection method" hint="Aligned views follow this with no edits.">
          <Segmented
            label="Projection method"
            size={sz}
            value={p.projection}
            onChange={p.onProjection}
            options={[
              { value: 'first', label: 'First angle' },
              { value: 'third', label: 'Third angle' },
            ]}
          />
        </Field>
        <Field
          label="Standard"
          hint="Changing the standard changes the sheet and style: make a new drawing."
        >
          <p className="text-ui" data-testid="drawing-standard">
            {p.family === 'iso' ? 'ISO' : 'ASME / ANSI'} · {p.gps} · {p.surfaceFinish}
          </p>
        </Field>
        <Field label="General tolerance note">
          <input
            aria-label="General tolerance"
            defaultValue={p.generalTolerance}
            key={p.generalTolerance}
            placeholder={p.family === 'iso' ? 'ISO 2768-mK' : 'none'}
            onBlur={(e) =>
              e.target.value !== p.generalTolerance && p.onGeneralTolerance(e.target.value)
            }
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className={field}
          />
        </Field>
        <Field label="Configuration">
          <select
            aria-label="Configuration of this drawing"
            value={p.configuration.value ?? 'default'}
            onChange={(e) =>
              p.onConfiguration(e.target.value === 'default' ? null : e.target.value)
            }
            className={field}
          >
            <option value="default">Default</option>
            {p.configuration.options
              .filter((o) => o.id !== null)
              .map((o) => (
                <option key={o.id} value={o.id as string}>
                  {o.name}
                </option>
              ))}
            {p.configuration.missing && typeof p.configuration.value === 'string' ? (
              <option value={p.configuration.value}>Missing configuration</option>
            ) : null}
          </select>
          {p.configuration.value !== null || p.configuration.missing ? (
            <ConfigBadge
              name={
                p.configuration.options.find((o) => o.id === p.configuration.value)?.name ??
                'Missing configuration'
              }
              {...(p.configuration.missing ? { missing: true } : {})}
            />
          ) : null}
        </Field>
      </Section>
      <Section title="Sheet">
        <Field label="Size">
          <select
            aria-label="Sheet size"
            value={sizeKey}
            onChange={(e) => p.onFormat({ ...p.sheet.format, size: e.target.value as never })}
            className={field}
          >
            {choices.map((c) => (
              <option key={c} value={c}>
                {SHEET_SIZE_LABELS[c]}
              </option>
            ))}
            {sizeKey === 'custom' ? <option value="custom">Custom</option> : null}
          </select>
        </Field>
        <Segmented
          label="Orientation"
          size={sz}
          value={p.sheet.format.orientation}
          onChange={(orientation) => p.onFormat({ ...p.sheet.format, orientation })}
          options={[
            { value: 'landscape', label: 'Landscape' },
            { value: 'portrait', label: 'Portrait' },
          ]}
        />
        <Field
          label="Sheet scale"
          hint="The default for the views on this sheet. Type 1:2, 2:1 or 1/2."
        >
          <ExpressionInput
            label="Sheet scale"
            value={p.sheet.scale}
            evaluate={p.evaluateScale}
            onCommit={p.onSheetScale}
            size={sz}
            paramLinks="off"
            showValue={false}
            testId="sheet-scale"
          />
        </Field>
        <p className="text-2xs text-fg-subtle">
          Template {p.template.id}, version {p.template.version}.
        </p>
        {p.template.version < p.template.latest ? (
          <Button variant="secondary" size={sz} onClick={p.onReapplyTemplate}>
            Re-apply the latest template
          </Button>
        ) : null}
      </Section>
      <Section title="Sheets">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {p.sheets.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-2.5 py-1.5 text-ui"
            >
              <span className="truncate">{s.name}</span>
              {p.sheets.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => p.onRemoveSheet(s.id)}
                  className="flex size-7 items-center justify-center rounded-control text-fg-muted hover:bg-surface-3"
                >
                  <Trash2 className="size-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <Button
          variant="secondary"
          size={sz}
          icon={<Plus className="size-4" />}
          onClick={p.onAddSheet}
        >
          Add sheet
        </Button>
      </Section>
    </div>
  );
}
