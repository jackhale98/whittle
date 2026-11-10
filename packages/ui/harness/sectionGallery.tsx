import { useState } from 'react';
import { SectionChip, SectionPanel, type SectionPanelProps } from '../src';

/* Section view fixes: the persistent chip in every state and size, and the panel's tilt fields
   (axis plane, face plane, an invalid angle). The live cut, caps and the manipulator are driven by
   the apps/web E2E. */

type Tier = 'desktop' | 'tablet' | 'phone';
const card = 'w-card w-[320px] overflow-hidden';
const noop = () => {};

function Panel({
  tier,
  testId,
  ...over
}: { tier: Tier; testId: string } & Partial<SectionPanelProps>) {
  const [tilt, setTilt] = useState({ u: (15 * Math.PI) / 180, v: 0.2 });
  const [offset, setOffset] = useState(12);
  return (
    <div className={card} data-testid={testId} data-tier={tier}>
      <SectionPanel
        enabled
        onEnabledChange={noop}
        axis="z"
        onAxisChange={noop}
        offset={offset}
        range={{ min: 0, max: 40 }}
        onOffsetChange={setOffset}
        flipped={false}
        onFlippedChange={noop}
        tilt={{
          u: tilt.u,
          v: tilt.v,
          labels: ['Tilt about X', 'Tilt about Y'],
          onChange: (p) => setTilt((t) => ({ u: p.tiltU ?? t.u, v: p.tiltV ?? t.v })),
        }}
        {...over}
      />
    </div>
  );
}

export function SectionGallery({ section, tier }: { section: string; tier: Tier }) {
  const touch = tier !== 'desktop';
  const size = touch ? 'touch' : 'md';
  if (section === 'section-chip') {
    return (
      <div className="flex flex-col items-start gap-4 p-4" data-testid="g-section-chip">
        <SectionChip size={size} onExit={noop} onFlip={noop} onEdit={noop} />
        <SectionChip size={size} onExit={noop} onFlip={noop} onEdit={noop} flipped />
        <SectionChip size={size} onExit={noop} onFlip={noop} onEdit={noop} editing />
        <SectionChip size={size} onExit={noop} onFlip={noop} onEdit={noop} editing flipped />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 p-4 md:flex-row" data-testid="g-section-panel">
      <Panel tier={tier} testId="section-panel-axis" />
      <Panel
        tier={tier}
        testId="section-panel-face"
        axis="face"
        faceLabel="Face of Extrude 1"
        flipped
      />
      <Panel tier={tier} testId="section-panel-off" enabled={false} />
    </div>
  );
}
