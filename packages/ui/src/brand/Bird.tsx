/**
 * Whittle brand mark (the perched bird) and the whittling loader, from the brand kit (brand/).
 * Fills are theme variables from brand.css, so one inline SVG follows light/dark and the wing
 * takes the app accent. Geometry is the kit's 100 × 100 artboard.
 */
import { cn } from '../components/primitives';

const ACCENT = 'var(--whittle-accent)';

/** The finished bird on its perch (`final()` in brand/build.py). */
function FinishedBird({ detail = true }: { detail?: boolean }) {
  return (
    <>
      <polygon points="12,52 30,50 34,58" fill="var(--wb-0)" />
      <polygon points="12,52 34,58 40,62 28,62" fill="var(--wb-1)" />
      <polygon points="30,50 56,32 60,44 44,52" fill="var(--wb-2)" />
      <polygon points="34,58 30,50 44,52 60,44 56,58 40,62" fill={ACCENT} />
      <polygon points="56,32 64,24 72,26 76,32 70,42 60,44" fill="var(--wb-3)" />
      <polygon points="76,32 86,36 74,39" fill="var(--wb-1)" />
      <polygon points="60,44 70,42 68,56 56,58" fill="var(--wb-2)" />
      <polygon points="40,62 56,58 68,56 60,68 46,70" fill="var(--wb-3)" />
      {detail ? (
        <>
          <circle cx="69" cy="31" r="1.8" fill="var(--wb-eye)" />
          <path
            d="M50 70 L48 76 M56 68 L56 76"
            stroke="var(--wb-1)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      ) : null}
      <polygon points="34,76 70,76 66,82 38,82" fill="var(--wb-0)" />
    </>
  );
}

function Block() {
  return (
    <>
      <polygon points="14,26 80,26 80,84 14,84" fill="var(--wb-block-front)" />
      <polygon points="14,26 22,18 88,18 80,26" fill="var(--wb-block-top)" />
      <polygon points="80,26 88,18 88,76 80,84" fill="var(--wb-block-side)" />
    </>
  );
}

/** Static logo mark. Decorative by default; pass `label` when it stands alone. */
export function BirdMark({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn('size-6 shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid="whittle-mark"
    >
      <FinishedBird />
    </svg>
  );
}

/**
 * Animated loader: a block whittled into the bird, chips flying at each cut, then the bird slides
 * out as a new block slides in (seamless 4.4 s loop). Static finished bird under reduced motion.
 */
export function WhittleLoader({
  className,
  label = 'Loading',
}: {
  className?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn('size-24 shrink-0', className)}
      role="img"
      aria-label={label}
      data-testid="whittle-loader"
    >
      <g className="wl-b0">
        <Block />
      </g>
      <g className="wl-b1">
        <polygon points="14,54 54,30 70,24 84,36 64,46 58,70 36,70" fill="var(--wb-2)" />
        <polygon points="34,74 70,74 70,82 34,82" fill="var(--wb-0)" />
      </g>
      <g className="wl-b2">
        <polygon points="54,30 70,24 84,36 66,44" fill="var(--wb-3)" />
        <polygon points="14,54 54,30 66,44 40,54" fill={ACCENT} />
        <polygon points="40,54 66,44 58,70 36,70" fill="var(--wb-2)" />
        <polygon points="14,54 40,54 36,70" fill="var(--wb-0)" />
        <polygon points="34,74 70,74 68,82 36,82" fill="var(--wb-0)" />
      </g>
      <g className="wl-b3">
        <FinishedBird />
      </g>
      <g className="wl-bin">
        <Block />
      </g>
      <polygon className="wl-chip wl-c1" points="58,32 62,31 60,35" fill={ACCENT} />
      <polygon className="wl-chip wl-c2" points="38,56 41,54 41,58" fill="var(--wb-2)" />
      <polygon className="wl-chip wl-c3" points="64,62 68,61 66,65" fill="var(--wb-2)" />
    </svg>
  );
}
