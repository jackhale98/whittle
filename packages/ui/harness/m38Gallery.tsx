import { Maximize, Redo2, Ruler, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { RadialEditor, type RadialEditorCommand } from '../src';

const ic = 'size-3.5';
const commands: RadialEditorCommand[] = [
  { id: 'sketch', label: 'Sketch', group: 'Modeling' },
  { id: 'extrude', label: 'Extrude', group: 'Modeling' },
  { id: 'pushPull', label: 'Push/pull', group: 'Modeling' },
  { id: 'hole', label: 'Hole', group: 'Modeling' },
  { id: 'shell', label: 'Shell', group: 'Modeling' },
  { id: 'fillet', label: 'Fillet', group: 'Modeling' },
  { id: 'measure', label: 'Measure', group: 'Modeling', icon: <Ruler className={ic} /> },
  { id: 'fit', label: 'Fit view', group: 'View and history', icon: <Maximize className={ic} /> },
  { id: 'undo', label: 'Undo', group: 'View and history', icon: <Undo2 className={ic} /> },
  { id: 'redo', label: 'Redo', group: 'View and history', icon: <Redo2 className={ic} /> },
];
const contexts = [
  { id: 'face', label: 'Face', hint: 'One or more faces are selected.' },
  { id: 'edge', label: 'Edge', hint: 'One or more edges are selected.' },
];
const defaults: Record<string, (string | null)[]> = {
  face: ['sketch', 'pushPull', 'hole', 'shell', null, 'measure', 'fit'],
  edge: ['fillet', null, 'measure', null, null, null, null],
};

export function M38Gallery({ section }: { section: string }) {
  const state = new URLSearchParams(window.location.search).get('state') ?? 'default';
  const [rings, setRings] = useState(defaults);
  const [flick, setFlick] = useState(state === 'off' ? 0 : 250);
  const [delay, setDelay] = useState(state === 'delay');
  if (section !== 'm38-radial-editor') return null;
  return (
    <div className="w-[min(100vw-24px,420px)] p-3" data-testid="g-m38-editor">
      <RadialEditor
        size={window.innerWidth < 600 ? 'touch' : 'md'}
        contexts={contexts}
        ringOf={(c) => rings[c] ?? []}
        commandsOf={() => commands}
        modified={state === 'modified' || state === 'notice' ? ['face'] : []}
        onRingChange={(c, r) => setRings((x) => ({ ...x, [c]: [...r] }))}
        onResetContext={() => setRings(defaults)}
        onResetAll={() => setRings(defaults)}
        flickWindow={flick}
        onFlickWindow={setFlick}
        drawAfterDelay={delay}
        onDrawAfterDelay={setDelay}
        notice={
          state === 'notice' ? 'Removed 2 commands that no longer exist: oldTool, gone.' : null
        }
        onDismissNotice={() => {}}
        onExport={() => {}}
        onImport={() => {}}
      />
    </div>
  );
}
