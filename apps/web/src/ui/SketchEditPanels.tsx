/**
 * The sketch Edit-menu panels (packages/ui `EditChrome`, ADR-038) driven by the sketch session's
 * edit tools (`app/sketch-edit.ts`), and the Linked panel for converted geometry: its source, Unlink,
 * and — when the source is lost — the ghost note and Re-pick. Non-modal: they float over the view.
 */

import type { Id, SketchFeature, WrenDoc } from '@wren-cad/contracts';
import { Namer, SKETCH_X_AXIS, SKETCH_Y_AXIS } from '@wren-cad/sketch';
import {
  ConvertPanel,
  LinkedEntityPanel,
  type LinkedState,
  OffsetPanel,
  PromptChip,
  SketchCornerPanel,
  SketchMirrorPanel,
  TrimExtendPanel,
} from '@wren-cad/ui';
import { useObservable } from '../app/observable';
import { linkedSources } from '../app/sketch-edit';
import type { SketchSession } from '../app/sketch-session';
import type { SketchUi } from '../app/state';
import type { Workbench } from '../app/workbench';
import { describeEdgeName } from '../model/explain';
import { describeRef } from './Inspector';

/** Entity ids of a sketch whose linked source no longer resolves (needs attention). */
function lostEntities(wb: Workbench, f: SketchFeature): Set<Id> {
  const status = wb.treeStatuses.get()?.find((s) => s.featureId === f.id);
  const out = new Set<Id>();
  for (const u of status?.unresolved ?? []) {
    const m = /^\/entities\/(\d+)\/source\/ref$/.exec(u.path);
    const e = m ? f.entities[Number(m[1])] : undefined;
    if (e) out.add(e.id);
  }
  return out;
}

function axisLabel(f: SketchFeature, id: Id | null): string | null {
  if (!id) return null;
  if (id === SKETCH_X_AXIS) return 'Horizontal axis';
  if (id === SKETCH_Y_AXIS) return 'Vertical axis';
  return new Namer(f.entities).entity(id);
}

export function SketchEditPanels({
  wb,
  session,
  ui,
  doc,
  touch,
}: {
  wb: Workbench;
  session: SketchSession;
  ui: SketchUi;
  doc: WrenDoc;
  touch: boolean;
}) {
  useObservable(wb.treeStatuses);
  const f = doc.parts[0]?.features.find((x) => x.id === ui.featureId);
  if (f?.type !== 'sketch') return null;
  const size = touch ? 'touch' : 'md';
  const tools = session.edits;
  const e = ui.edit;
  const done = () => session.setTool(null);
  const length = (x: string) => wb.evaluate(x, 'length');
  const value = {
    value: e?.value ?? '',
    evaluate: length,
    onPreview: (x: string) => tools.setValue(x),
    onCommit: (x: string) => tools.setValue(x),
    size,
  } as const;

  if (e?.relink) {
    return (
      <PromptChip size={size} onCancel={done}>
        Click the model edge the linked geometry should follow now
      </PromptChip>
    );
  }
  switch (e?.tool) {
    case 'offset':
      return (
        <OffsetPanel
          {...value}
          side={e.side}
          both={e.both}
          count={e.picks.length}
          onSide={(s) => tools.setSide(s)}
          onBoth={(b) => tools.setBoth(b)}
          onApply={() => void wb.track(tools.apply())}
          onCancel={done}
        />
      );
    case 'convert':
      return (
        <ConvertPanel
          source={e.source}
          count={e.model.length}
          onSource={(s) => tools.setSource(s)}
          onApply={() => void wb.track(tools.apply())}
          onCancel={done}
          size={size}
        />
      );
    case 'trim':
    case 'extend':
      return (
        <TrimExtendPanel mode={e.trim} onMode={(m) => tools.setTrim(m)} onDone={done} size={size} />
      );
    case 'sketchFillet':
    case 'sketchChamfer':
      return (
        <SketchCornerPanel
          {...value}
          kind={e.corner}
          onKind={(k) => tools.setCorner(k)}
          count={e.picks.length}
          onApply={() => void wb.track(tools.apply())}
          onCancel={done}
        />
      );
    case 'sketchMirror':
      return (
        <SketchMirrorPanel
          count={e.picks.length}
          axisLabel={axisLabel(f, e.axis)}
          phase={e.phase}
          onPhase={(p) => tools.setPhase(p)}
          onApply={() => void wb.track(tools.apply())}
          onCancel={done}
          size={size}
        />
      );
    default:
      break;
  }

  // Select tool: converted geometry in the selection shows where it comes from.
  const groups = linkedSources(f, ui.selected);
  const first = groups[0];
  if (!first) return null;
  const lost = lostEntities(wb, f);
  const isLost = groups.some((g) => g.ids.some((id) => lost.has(id)));
  const state: LinkedState = isLost ? 'lost' : first.approximate ? 'approximate' : 'linked';
  const ids = groups.flatMap((g) => g.ids);
  const source =
    first.ref.kind === 'edge' && first.ref.name.startsWith('edge(')
      ? describeEdgeName(doc, first.ref.name)
      : describeRef(doc, first.ref);
  return (
    <LinkedEntityPanel
      state={state}
      sourceLabel={groups.length > 1 ? `${groups.length} model sources` : source}
      count={ids.length}
      onUnlink={() => void wb.track(tools.unlink(ids))}
      {...(isLost ? { onRepick: () => tools.startRelink(first.ref.name) } : {})}
      size={size}
    />
  );
}
