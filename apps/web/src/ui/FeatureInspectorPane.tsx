/**
 * The feature inspector with its lineage (parents and children), for the feature being edited.
 * Lazy: the form fields for every feature type are not part of the first screen.
 */

import type { Feature, FeatureStatus, WrenDoc } from '@wren-cad/contracts';
import { FeatureInspector, FeatureLineage } from '@wren-cad/ui';
import type { Workbench } from '../app/workbench';
import { featureLineage } from '../model/lineage';
import { describeRef } from './Inspector';

type HoleTables = typeof import('../features/hole-tables')['HOLE_TABLES'];

export default function FeatureInspectorPane({
  wb,
  doc,
  f,
  status,
  pickingPath,
  tables,
  density,
}: {
  wb: Workbench;
  doc: WrenDoc;
  f: Feature;
  status?: FeatureStatus;
  pickingPath: string | null;
  tables?: HoleTables;
  density: 'compact' | 'touch';
}) {
  const part = doc.parts[0];
  const lineage = featureLineage(doc, f.id);
  return (
    <>
      <FeatureInspector
        key={f.id}
        feature={f}
        {...(status ? { status } : {})}
        evaluate={(e, d) => wb.evaluate(e, d)}
        onChange={(next: Feature) => wb.updateFeature(next, 'commit')}
        onPreview={(next: Feature) => wb.updateFeature(next, 'preview')}
        onPick={(path) =>
          status?.unresolved?.some((u) => u.path === path)
            ? wb.repick(f.id, path)
            : wb.startPicking(f.id, path)
        }
        {...(status?.state === 'needsAttention' ? { onRepick: () => wb.repick(f.id) } : {})}
        pickingPath={pickingPath}
        describeRef={(r) => describeRef(doc, r)}
        describeFeature={(id) =>
          part?.features.find((x) => x.id === id)?.name ?? wb.rememberedName(id) ?? id
        }
        onSelectFeature={(id) => wb.selectFeature(id)}
        onUndo={() => wb.undo()}
        {...(tables ? { holeTables: tables } : {})}
        {...(f.type === 'sketch' ? { onEditSketch: () => wb.editFeature(f.id) } : {})}
        onDone={() => wb.selectFeature(null)}
        units={{ length: doc.units.length, angle: doc.units.angle === 'deg' ? '°' : 'rad' }}
        density={density}
      />
      {f.type !== 'sketch' || lineage.children.length > 0 || lineage.parents.length > 0 ? (
        <FeatureLineage
          parents={lineage.parents}
          dependents={lineage.children}
          onSelect={(id) => wb.selectFeature(id)}
        />
      ) : null}
    </>
  );
}
