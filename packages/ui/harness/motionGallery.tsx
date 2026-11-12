import { DEFAULT_MOTION_SETTINGS, type MotionInputState } from '@wren-cad/contracts';
import {
  DEFAULT_MOTION_BUTTONS,
  MotionButtonMapping,
  MotionDiagnostics,
  MotionSettingsSection,
} from '../src';

/* M4.5 3D mouse UI: the diagnostics panel in each of its five states, the Settings section and the
   button mapping. The live device and button behaviour are driven by the apps/web E2E. */

type Tier = 'desktop' | 'tablet' | 'phone';
const noop = () => {};
const dev = { name: 'Example 6-DoF controller', vendorId: 1, productId: 2 };

export const MOTION_STATES: Record<string, MotionInputState> = {
  unsupported: { path: 'none', state: 'unsupported' },
  notPaired: { path: 'none', state: 'notPaired' },
  disconnected: { path: 'none', state: 'disconnected' },
  noReports: { path: 'webhid', state: 'noReports', device: dev, buttons: [] },
  live: {
    path: 'webhid',
    state: 'live',
    device: dev,
    buttons: [1, 3],
    last: { t: [0.6, -0.3, 0.1], r: [-0.2, 0, 0.8], time: 0 },
  },
};

export function MotionGallery({ section, tier }: { section: string; tier: Tier }) {
  const size = tier === 'desktop' ? 'md' : 'touch';
  if (section === 'motion-settings') {
    return (
      <div className="w-card w-[400px] p-3" data-testid="g-motion-settings">
        <MotionSettingsSection
          value={{ ...DEFAULT_MOTION_SETTINGS, sensitivity: 2, dominant: true }}
          onChange={noop}
          state={MOTION_STATES.live as MotionInputState}
          onPair={noop}
          onOpenDiagnostics={noop}
          size={size}
        />
        <MotionButtonMapping
          map={DEFAULT_MOTION_BUTTONS}
          onChange={noop}
          seen={3}
          pressed={[3]}
          size={size}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-4 p-4" data-testid="g-motion-states">
      {Object.entries(MOTION_STATES).map(([k, s]) => (
        <div key={k} className="w-card w-[360px] p-3" data-testid={`motion-state-${k}`}>
          <MotionDiagnostics state={s} onPair={noop} size={size} />
        </div>
      ))}
    </div>
  );
}
