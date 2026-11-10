/**
 * Notices of the configuration system (M3.7), in the viewport overlay: the undoable "Changed in
 * all N configurations" after editing an inherited value (research P0 2), and the persistent
 * "needs attention" for a configuration that is missing (trap T2) or has overrides that no longer
 * apply. Non-modal; nothing here takes focus.
 */

import { ChangedInAllNotice } from '@wren-cad/ui';
import { TriangleAlert } from 'lucide-react';
import { partLevelIssues } from '../app/config-model';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';
import { MISSING_TEXT, useConfigurationView } from './config-view';

export function ConfigNotices({ wb, touch }: { wb: Workbench; touch: boolean }) {
  const state = useObservable(wb.config.state);
  const v = useConfigurationView(wb);
  const part = wb.part;
  const issues = v.missing ? [] : partLevelIssues(wb.config.resolved().issues);
  return (
    <>
      {v.missing ? (
        <div
          role="alert"
          data-testid="config-missing"
          className="pointer-events-auto absolute top-16 left-1/2 flex w-[min(34rem,calc(100%-1.5rem))] -translate-x-1/2 gap-2 rounded-panel bg-warning-soft p-3 text-ui text-warning-text shadow-pop"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Configuration needs attention</p>
            <p className="mt-0.5">{MISSING_TEXT}</p>
            <button
              type="button"
              onClick={() => wb.config.setActive(null)}
              className={`mt-1.5 rounded-control bg-surface px-2.5 text-ui font-medium text-fg shadow-[inset_0_0_0_1px_var(--color-border)] hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent ${touch ? 'min-h-11' : 'h-7'}`}
            >
              Switch to Default
            </button>
          </div>
        </div>
      ) : issues.length > 0 ? (
        <div
          role="alert"
          data-testid="config-issues"
          className="pointer-events-auto absolute top-16 left-1/2 flex w-[min(34rem,calc(100%-1.5rem))] -translate-x-1/2 gap-2 rounded-panel bg-warning-soft p-3 text-ui text-warning-text shadow-pop"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{v.activeName} needs attention</p>
            <ul className="m-0 mt-0.5 list-none p-0">
              {issues.map((i) => (
                <li key={`${i.target.kind}:${i.reason}`}>{i.reason}.</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {state.notice && part ? (
        <div
          className="pointer-events-auto absolute left-1/2 w-[min(28rem,calc(100%-1.5rem))] -translate-x-1/2"
          style={{ bottom: 'calc(var(--chrome-bottom, 5.75rem) + 12px)' }}
        >
          <ChangedInAllNotice
            count={state.notice.count}
            size={touch ? 'touch' : 'md'}
            onUndo={() => {
              wb.undo();
              wb.config.dismissNotice();
            }}
            onDismiss={() => wb.config.dismissNotice()}
          />
        </div>
      ) : null}
    </>
  );
}
