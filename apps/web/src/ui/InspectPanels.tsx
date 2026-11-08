/**
 * Measure and Section in the desktop/tablet inspector (the phone shows the same panels in its
 * sheet). Loaded on first use, so neither is on the initial route (PLAN §10).
 */

import {
  Button,
  MeasurePanel,
  type MeasurePanelProps,
  SectionPanel,
  type SectionPanelProps,
} from '@whittle/ui';

function Header({
  title,
  hint,
  onDone,
  touch,
}: {
  title: string;
  hint: string;
  onDone(): void;
  touch: boolean;
}) {
  return (
    <header className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm leading-5 font-semibold">{title}</h2>
        <p className="text-2xs text-fg-muted">{hint}</p>
      </div>
      <Button variant="primary" size={touch ? 'touch' : 'md'} onClick={onDone}>
        Done
      </Button>
    </header>
  );
}

export function MeasureView({
  measure,
  onDone,
  touch,
}: {
  measure: MeasurePanelProps;
  onDone(): void;
  touch: boolean;
}) {
  return (
    <div data-testid="measure-inspector">
      <Header
        title="Measure"
        hint={
          touch
            ? 'Tap one or two faces, edges or points'
            : 'Click one or two faces, edges or points'
        }
        onDone={onDone}
        touch={touch}
      />
      <MeasurePanel {...measure} />
    </div>
  );
}

export function SectionView({
  section,
  onDone,
  touch,
}: {
  section: SectionPanelProps;
  onDone(): void;
  touch: boolean;
}) {
  return (
    <div data-testid="section-inspector">
      <Header
        title="Section view"
        hint="Slice the model to look inside"
        onDone={onDone}
        touch={touch}
      />
      <SectionPanel {...section} />
    </div>
  );
}
