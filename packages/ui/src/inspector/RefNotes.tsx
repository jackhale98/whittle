import type { EntityRef, Feature, FeatureStatus } from '@wren-cad/contracts';
import { Check, Info, RefreshCw } from 'lucide-react';
import { Button } from '../components/primitives';

/** The entity ref a JSON-pointer-like field path (`/edges/0`, `/profile`) points at, if it is one. */
export function refAtPath(feature: Feature, path: string): EntityRef | null {
  const v = path
    .split('/')
    .slice(1)
    .reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      feature,
    );
  const r = v as Partial<EntityRef> | undefined;
  return r && typeof r.name === 'string' && typeof r.kind === 'string' ? (r as EntityRef) : null;
}

export type RefNote =
  | { kind: 'merged'; path: string; name: string; into: string }
  | { kind: 'grown'; path: string; name: string; was: number; now: number };

/** The merged and grown notes of a feature's status, grown first (it asks for a decision). */
export function refNotesOf(status: FeatureStatus | undefined): RefNote[] {
  return [
    ...(status?.grown ?? []).map((g) => ({ kind: 'grown' as const, ...g })),
    ...(status?.merged ?? []).map((m) => ({ kind: 'merged' as const, ...m })),
  ];
}

const nounOf = (ref: EntityRef | null) =>
  ref?.kind === 'face' ? 'face' : ref?.kind === 'edge' ? 'edge' : 'reference';

/** mm² for a face, mm for an edge. */
const sizeOf = (v: number, ref: EntityRef | null) =>
  ref?.kind === 'edge' ? `${(Math.round(v * 10) / 10).toString()} mm` : `${Math.round(v)} mm²`;

export interface RefNotesProps {
  feature: Feature;
  status: FeatureStatus;
  /** "Edge of Plate": a readable name for a ref. */
  describeRef?(ref: EntityRef): string;
  /** Keeps the reference as it is and clears the note until it changes again. */
  onAccept(note: RefNote): void;
  /** Enters the re-pick flow for the field. */
  onRepick(path: string): void;
  touch?: boolean;
}

/**
 * Quiet notes under the feature's header: a reference that was resolved through a face merge, or
 * whose entity grew. The regen is not blocked and nothing is changed behind your back: you accept
 * the reference as it is, or pick it again.
 */
export function RefNotes({
  feature,
  status,
  describeRef,
  onAccept,
  onRepick,
  touch = false,
}: RefNotesProps) {
  const notes = refNotesOf(status);
  if (notes.length === 0) return null;
  const size = touch ? 'touch' : 'md';
  return (
    <ul
      data-testid="ref-notes"
      aria-label="References that changed meaning"
      className="m-0 mx-4 mt-3 flex list-none flex-col gap-2 p-0"
    >
      {notes.map((n) => {
        const ref = refAtPath(feature, n.path);
        const label = ref && describeRef ? describeRef(ref) : `the ${nounOf(ref)}`;
        return (
          <li
            key={`${n.kind}|${n.path}|${n.name}`}
            data-testid="ref-note"
            data-kind={n.kind}
            data-path={n.path}
            className="flex gap-2 rounded-control bg-surface-2 p-2.5 text-ui text-fg-muted"
          >
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-fg">
                {n.kind === 'grown' ? 'Check this reference' : `Uses a merged ${nounOf(ref)}`}
              </p>
              <p className="mt-0.5 text-xs" data-testid="ref-note-detail">
                {n.kind === 'grown'
                  ? `${label} was ${sizeOf(n.was, ref)} when you picked it and is ${sizeOf(n.now, ref)} now.`
                  : `${label} was merged into ${n.into} by a boolean. The stored name is kept.`}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size={size}
                  icon={<Check className="size-3.5" />}
                  onClick={() => onAccept(n)}
                  data-testid="ref-accept"
                >
                  Accept
                </Button>
                <Button
                  variant="secondary"
                  size={size}
                  icon={<RefreshCw className="size-3.5" />}
                  onClick={() => onRepick(n.path)}
                  data-testid="ref-repick"
                >
                  Re-pick
                </Button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
