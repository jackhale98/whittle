import type { FeatureStatus } from '@wren-cad/contracts';
import { useMemo } from 'react';
import { useObservable } from '../app/observable';
import { refAcks } from '../app/ref-notes';
import type { Workbench } from '../app/workbench';

/** The regen's feature statuses without the reference notes the user has accepted. */
export function useStatuses(wb: Workbench, docId: string): readonly FeatureStatus[] | undefined {
  const raw = useObservable(wb.treeStatuses);
  const version = useObservable(refAcks.version);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the acknowledgement change token
  return useMemo(() => refAcks.apply(docId, raw), [docId, raw, version]);
}
