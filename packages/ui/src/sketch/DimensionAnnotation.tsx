import { cn } from '../components/primitives';

type P = { x: number; y: number };

/**
 * Dimension annotation geometry in screen px (the app projects the sketch-local mm geometry from
 * `dimensionAnnotation(...)` in packages/sketch). Every part is optional: a linear dimension has
 * extension lines, a dimension line and two arrows; a radius or diameter has a leader; an angle
 * has an arc.
 */
export interface DimensionGeometry {
  /** Extension lines from the measured feature out past the dimension line. */
  extensions?: readonly { a: P; b: P }[];
  /** The dimension line (between the extension lines, or the leader's shaft). */
  line?: { a: P; b: P };
  /** Arrowheads: `tip` is the point, `dir` the direction the arrow points (need not be unit). */
  arrows?: readonly { tip: P; dir: P }[];
  /** Radius / diameter leader, drawn like `line` and hit-testable alike. */
  leader?: { a: P; b: P };
  /** Angle arc about `center` from angle `start` to `end` (radians, screen y down), radius px. */
  arc?: { center: P; radius: number; start: number; end: number };
}

export interface DimensionAnnotationProps {
  geometry: DimensionGeometry;
  /** Reference dimensions are drawn muted and dashed. */
  driving?: boolean;
  hovered?: boolean;
  selected?: boolean;
  conflicting?: boolean;
  /** Hover over any part of the annotation (hit width is 12 px). */
  onHover?(hovered: boolean): void;
  onSelect?(): void;
  /** Accessible name; the annotation is decorative (aria-hidden) when omitted. */
  label?: string;
  size?: number;
  className?: string;
}

const ARROW_LEN = 9;
const ARROW_HALF = 3.2;

/** Triangle path for an arrowhead at `tip` pointing along `dir`. */
export function arrowPath(tip: P, dir: P, len = ARROW_LEN, half = ARROW_HALF): string {
  const l = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / l;
  const uy = dir.y / l;
  const bx = tip.x - ux * len;
  const by = tip.y - uy * len;
  return `M${tip.x} ${tip.y}L${bx - uy * half} ${by + ux * half}L${bx + uy * half} ${by - ux * half}Z`;
}

/** SVG arc path for the angle arc (short way from `start` to `end`, sweeping increasing angle). */
export function arcPath(arc: NonNullable<DimensionGeometry['arc']>): string {
  const { center: c, radius: r, start, end } = arc;
  const sx = c.x + r * Math.cos(start);
  const sy = c.y + r * Math.sin(start);
  const ex = c.x + r * Math.cos(end);
  const ey = c.y + r * Math.sin(end);
  let span = end - start;
  while (span < 0) span += Math.PI * 2;
  while (span >= Math.PI * 2) span -= Math.PI * 2;
  return `M${sx} ${sy}A${r} ${r} 0 ${span > Math.PI ? 1 : 0} 1 ${ex} ${ey}`;
}

/**
 * SVG overlay for a dimension's annotation geometry. It fills its (positioned) parent, lets
 * pointer events through except on the strokes, and draws with theme tokens: the accent when
 * hovered or selected, danger when conflicting, muted and dashed for reference dimensions.
 */
export function DimensionAnnotation({
  geometry,
  driving = true,
  hovered,
  selected,
  conflicting,
  onHover,
  onSelect,
  label,
  size,
  className,
}: DimensionAnnotationProps) {
  const tone = conflicting
    ? 'text-danger'
    : selected || hovered
      ? 'text-accent'
      : driving
        ? 'text-fg-muted'
        : 'text-fg-subtle';
  const strokes: string[] = [];
  const seg = (s: { a: P; b: P }) => `M${s.a.x} ${s.a.y}L${s.b.x} ${s.b.y}`;
  for (const e of geometry.extensions ?? []) strokes.push(seg(e));
  if (geometry.line) strokes.push(seg(geometry.line));
  if (geometry.leader) strokes.push(seg(geometry.leader));
  if (geometry.arc) strokes.push(arcPath(geometry.arc));
  const d = strokes.join('');
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative (aria-hidden) unless `label` names it
    <svg
      data-testid="dimension-annotation"
      data-state={conflicting ? 'conflict' : selected ? 'selected' : hovered ? 'hover' : 'rest'}
      data-driving={driving}
      className={cn('pointer-events-none absolute inset-0 overflow-visible', tone, className)}
      width={size}
      height={size}
      fill="none"
      {...a11y}
    >
      <path
        d={d}
        stroke="currentColor"
        strokeWidth={selected || hovered ? 1.75 : 1.25}
        strokeDasharray={driving ? undefined : '4 3'}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {(geometry.arrows ?? []).map((a) => (
        <path
          key={`${a.tip.x},${a.tip.y}`}
          d={arrowPath(a.tip, a.dir)}
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={0.5}
          strokeLinejoin="round"
        />
      ))}
      {/* A fat transparent copy of the strokes is the hover / hit target. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover and click target of a decorative drawing; the label button is the accessible control */}
      <path
        d={d}
        data-testid="dimension-hit"
        stroke="transparent"
        strokeWidth={12}
        style={{ pointerEvents: onHover || onSelect ? 'stroke' : 'none' }}
        onPointerEnter={() => onHover?.(true)}
        onPointerLeave={() => onHover?.(false)}
        onClick={onSelect}
      />
    </svg>
  );
}
