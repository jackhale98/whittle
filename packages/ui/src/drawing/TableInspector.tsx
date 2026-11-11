import type { EvalResult, Expr, PartPropertiesTable, TableAnchor } from '@wren-cad/contracts';
import { Trash2 } from 'lucide-react';
import { Section, Segmented, Switch } from '../components/controls';
import { Button } from '../components/primitives';
import { SheetValueField } from './SheetValueField';

export const PROPERTY_COLUMN_LABELS: Record<PartPropertiesTable['columns'][number], string> = {
  partNumber: 'Part number',
  description: 'Description',
  material: 'Material',
  mass: 'Mass',
  configuration: 'Configuration',
};

const COLUMN_ORDER = [
  'partNumber',
  'description',
  'material',
  'mass',
  'configuration',
] as const satisfies readonly PartPropertiesTable['columns'][number][];

const ANCHORS: readonly { value: TableAnchor; label: string }[] = [
  { value: 'topLeft', label: 'Top left' },
  { value: 'topRight', label: 'Top right' },
  { value: 'bottomLeft', label: 'Bottom left' },
  { value: 'bottomRight', label: 'Bottom right' },
];

export interface TableInspectorProps {
  table: PartPropertiesTable;
  evaluate(expr: Expr): EvalResult;
  onChange(next: PartPropertiesTable, label: string): void;
  onDelete(): void;
  size?: 'md' | 'touch';
}

/**
 * Inspector of the part properties table: which columns it shows, the mass unit, and where it
 * sits (a corner and typed sheet coordinates, the inline alternative to dragging it). Its values
 * come from the drawing's configuration; nothing here is typed in the table itself.
 */
export function TableInspector({
  table,
  evaluate,
  onChange,
  onDelete,
  size = 'md',
}: TableInspectorProps) {
  const sz = size === 'touch' ? 'touch' : 'md';
  const has = (c: PartPropertiesTable['columns'][number]) => table.columns.includes(c);
  const toggle = (c: PartPropertiesTable['columns'][number], on: boolean) => {
    const columns = COLUMN_ORDER.filter((k) => (k === c ? on : has(k)));
    // A table with no column draws nothing: the last one stays.
    if (columns.length === 0) return;
    onChange({ ...table, columns }, 'Edit part properties table');
  };
  return (
    <div data-testid="table-inspector" className="flex flex-col">
      <Section title="Part properties table">
        <p className="text-2xs text-fg-muted">
          One row from the drawing’s configuration. Values come from the part and its title block,
          so editing them there updates the table.
        </p>
        <fieldset className="m-0 mt-2 flex flex-col gap-2 border-0 p-0">
          <legend className="sr-only">Columns</legend>
          {COLUMN_ORDER.map((k) => (
            <Switch
              key={k}
              checked={has(k)}
              onChange={(on) => toggle(k, on)}
              label={PROPERTY_COLUMN_LABELS[k]}
            />
          ))}
        </fieldset>
        {has('mass') ? (
          <div className="mt-2">
            <Segmented
              label="Mass unit"
              size={sz}
              value={table.massUnit ?? 'g'}
              onChange={(u) => onChange({ ...table, massUnit: u }, 'Edit part properties table')}
              options={[
                { value: 'g', label: 'g' },
                { value: 'kg', label: 'kg' },
              ]}
            />
          </div>
        ) : null}
      </Section>
      <Section title="Place on the sheet">
        <Segmented
          label="Corner the position refers to"
          size={sz}
          value={table.anchor}
          onChange={(anchor) => onChange({ ...table, anchor }, 'Move table')}
          options={ANCHORS.map((a) => ({ value: a.value, label: a.label }))}
        />
        <div className="mt-2 flex flex-col gap-2">
          <SheetValueField
            label="Table position X (mm)"
            value={table.position[0]}
            evaluate={evaluate}
            onCommit={(x) => onChange({ ...table, position: [x, table.position[1]] }, 'Move table')}
            size={sz}
          />
          <SheetValueField
            label="Table position Y (mm)"
            value={table.position[1]}
            evaluate={evaluate}
            onCommit={(y) => onChange({ ...table, position: [table.position[0], y] }, 'Move table')}
            size={sz}
          />
        </div>
        <p className="mt-2 text-2xs text-fg-subtle">Or drag the table on the sheet.</p>
      </Section>
      <Section title="Table">
        <Button
          variant="secondary"
          size={sz}
          icon={<Trash2 className="size-4" />}
          onClick={onDelete}
          data-testid="delete-table"
        >
          Delete table
        </Button>
      </Section>
    </div>
  );
}
