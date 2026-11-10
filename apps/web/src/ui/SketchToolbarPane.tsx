/** The sketch toolbar wired to the session. Lazy: sketch mode only. */

import { SketchToolbar } from '@wren-cad/ui';
import type { SketchSession } from '../app/sketch-session';
import type { SketchUi } from '../app/state';
import type { Workbench } from '../app/workbench';

export default function SketchToolbarPane({
  wb,
  session,
  sk,
  touch,
}: {
  wb: Workbench;
  session: SketchSession;
  sk: SketchUi;
  touch: boolean;
}) {
  return (
    <SketchToolbar
      activeTool={sk.tool}
      variants={sk.variants}
      onTool={(tool, variant) => {
        if (tool === null && session.escapeTool()) return;
        session.setTool(tool, variant);
      }}
      construction={sk.construction}
      onToggleConstruction={() => session.toggleConstruction()}
      onConstraint={(k) => session.constrain(k)}
      enabledConstraints={session.enabledConstraints()}
      onFinish={() => session.finish()}
      onEscape={() => session.finish()}
      matchShortcut={wb.sketchShortcut}
      density={touch ? 'touch' : 'compact'}
    />
  );
}
