import type { Id } from '@wren-cad/contracts';
import {
  Ban,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  EyeOff,
  GripVertical,
  TriangleAlert,
} from 'lucide-react';
import { m } from 'motion/react';
import type { PointerEvent } from 'react';
import type { FloatingAnchor } from '../components/floating';
import { cn, Tooltip } from '../components/primitives';
import { CauseSentence } from '../inspector/CauseSentence';
import { toggledVisibility } from '../logic/treeFolders';
import type { useSpring } from '../motion';
import type { FeatureTreeItem, FeatureTreeProps } from './FeatureTree';
import { featureMeta } from './featureMeta';
import type { StatusLine } from './featureStatus';
import { SketchEye } from './SketchEye';

/** The visible body of a feature row: grip, nest toggle, icon, name (inline rename), status, eye, menu. */
export function FeatureRowBody({
  shakeKey,
  isShaking,
  rejectSpring,
  indent,
  indentPx,
  rowH,
  isMoving,
  selected,
  nested,
  anyNested,
  kidCount,
  open,
  chevronW,
  touch,
  canMove,
  onGripDown,
  onGripMove,
  onGripUp,
  onGripCancel,
  onToggle,
  f,
  st,
  rolled,
  suppressed,
  suppressOverridden,
  renaming,
  rowKey,
  onRename,
  setRenaming,
  refocus,
  hidden,
  onSelect,
  shared,
  hasEye,
  isReference,
  onSketchVisibility,
  shown,
  setFocusKey,
  setMenu,
}: {
  shakeKey: number;
  isShaking: boolean;
  rejectSpring: ReturnType<typeof useSpring>;
  indent: number;
  indentPx: number;
  rowH: string;
  isMoving: boolean;
  selected: boolean;
  nested: boolean;
  anyNested: boolean;
  kidCount: number;
  open: boolean;
  chevronW: string;
  touch: boolean;
  canMove: boolean;
  onGripDown(e: PointerEvent<HTMLElement>): void;
  onGripMove(e: PointerEvent<HTMLElement>): void;
  onGripUp(): void;
  onGripCancel(): void;
  onToggle(id: Id): void;
  f: FeatureTreeItem;
  st: StatusLine | null;
  rolled: boolean;
  suppressed: boolean;
  /** M3.7: the active configuration overrides this feature's suppression. */
  suppressOverridden?: boolean;
  renaming: boolean;
  rowKey: string;
  onRename: FeatureTreeProps['onRename'];
  setRenaming(key: string | null): void;
  refocus(key: string): void;
  hidden: string;
  onSelect: FeatureTreeProps['onSelect'];
  shared: number;
  /** The row has a viewport eye: a sketch, or reference geometry. */
  hasEye: boolean;
  isReference: boolean;
  onSketchVisibility: FeatureTreeProps['onSketchVisibility'];
  shown: boolean;
  setFocusKey(key: string): void;
  setMenu(menu: { key: string; anchor: FloatingAnchor }): void;
}) {
  const meta = featureMeta[f.type];
  return (
    <m.div
      key={shakeKey}
      initial={isShaking ? { x: 9 } : false}
      animate={{ x: 0 }}
      transition={rejectSpring}
      style={indent ? { marginLeft: indent * indentPx } : undefined}
      className={cn(
        'flex items-start gap-2 rounded-[9px] pr-1 pl-1 transition-colors duration-fast',
        rowH,
        'group-focus-visible/row:outline-2 group-focus-visible/row:outline-offset-[-2px] group-focus-visible/row:outline-accent',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
        isMoving && 'bg-surface shadow-float',
        isShaking && 'bg-danger-soft',
      )}
    >
      {nested ? null : (
        <span
          aria-hidden
          data-grip
          data-no-longpress
          onPointerDown={(e) => onGripDown(e)}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripCancel}
          className={cn(
            'mt-[7px] flex shrink-0 touch-none items-center text-fg-subtle',
            canMove ? 'cursor-grab active:cursor-grabbing' : 'invisible',
            touch ? 'mt-[11px] w-6' : 'w-4',
            touch ? '' : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
          )}
        >
          <GripVertical className="size-4" />
        </span>
      )}
      {nested || !anyNested ? null : kidCount ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          data-testid="nest-toggle"
          aria-label={`${open ? 'Collapse' : 'Expand'} ${f.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(f.id);
          }}
          className={cn(
            'flex shrink-0 items-center justify-center rounded-[6px] text-fg-muted hover:bg-surface-3 hover:text-fg',
            chevronW,
            touch ? 'h-11' : 'mt-[7px] h-4',
          )}
        >
          <ChevronRight
            className={cn('size-3.5 transition-transform duration-fast', open && 'rotate-90')}
            aria-hidden
          />
        </button>
      ) : (
        <span aria-hidden className={cn('shrink-0', chevronW)} />
      )}
      <span
        className={cn(
          'flex shrink-0 items-center justify-center',
          touch ? 'mt-[11px]' : 'mt-[7px]',
          st?.tone === 'danger'
            ? 'text-danger'
            : selected
              ? 'text-accent-text'
              : rolled
                ? 'text-fg-subtle opacity-70'
                : 'text-fg-muted',
        )}
      >
        <meta.Icon className="size-[18px]" strokeWidth={1.6} aria-hidden />
      </span>
      <div className={cn('min-w-0 flex-1', touch ? 'py-[11px]' : 'py-[5px]')}>
        {renaming ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: inline rename focuses its field by design
            autoFocus
            aria-label={`Rename ${f.name}`}
            defaultValue={f.name}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                e.currentTarget.dataset.cancel = '1';
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              const cancelled = e.currentTarget.dataset.cancel === '1';
              setRenaming(null);
              if (!cancelled && v && v !== f.name) onRename?.(f.id, v);
              refocus(rowKey);
            }}
            className="h-6 w-full min-w-0 rounded-[6px] bg-surface px-1.5 text-ui text-fg shadow-[inset_0_0_0_2px_var(--color-accent)] outline-none"
          />
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: double-click rename; keyboard uses Enter/F2 on the row
          <span
            onDoubleClick={(e) => {
              if (!onRename) return;
              e.stopPropagation();
              setRenaming(rowKey);
            }}
            className={cn(
              'block truncate text-ui leading-[22px] font-medium',
              rolled && !suppressed && 'text-fg-subtle',
              suppressed && 'text-fg-muted line-through decoration-fg-subtle',
              st?.tone === 'danger' && !suppressed && 'text-danger-text',
            )}
          >
            {f.name}
          </span>
        )}
        {st ? (
          <Tooltip content={st.hint ?? st.message} side="bottom">
            <span
              data-testid="feature-message"
              className={cn(
                'mt-px flex items-start gap-1 text-2xs leading-4',
                st.tone === 'danger' && 'text-danger-text',
                st.tone === 'warning' && 'text-warning-text',
                st.tone === 'muted' && 'text-fg-muted',
              )}
            >
              {st.tone === 'danger' ? (
                <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
              ) : st.tone === 'warning' ? (
                <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
              ) : (
                <Ban className="mt-px size-3 shrink-0" aria-hidden />
              )}
              <span>
                {st.sentence ? (
                  <CauseSentence
                    sentence={st.sentence}
                    inTree
                    {...(onSelect ? { onSelectFeature: onSelect } : {})}
                  />
                ) : (
                  st.message
                )}
              </span>
            </span>
          </Tooltip>
        ) : null}
        <span className="sr-only">{hidden}</span>
      </div>
      {shared ? (
        <span
          aria-hidden
          data-testid="used-by"
          className={cn(
            'shrink-0 rounded-full bg-surface-3 px-1.5 text-2xs leading-4 font-medium whitespace-nowrap text-fg-muted',
            touch ? 'mt-[14px]' : 'mt-[8px]',
          )}
        >
          used by {shared}
        </span>
      ) : null}
      {suppressOverridden ? (
        <span
          aria-hidden
          data-testid="suppress-override-marker"
          title="Suppression overridden in this configuration"
          className={cn(
            'shrink-0 rounded-full bg-warning-soft px-1.5 text-2xs leading-4 font-medium whitespace-nowrap text-warning-text',
            touch ? 'mt-[14px]' : 'mt-[8px]',
          )}
        >
          Override
        </span>
      ) : null}
      {suppressed ? (
        <EyeOff
          className={cn('shrink-0 text-fg-subtle', touch ? 'mt-[13px] size-4' : 'mt-[8px] size-4')}
          aria-hidden
        />
      ) : null}
      {hasEye && onSketchVisibility ? (
        <SketchEye
          reference={isReference}
          name={f.name}
          shown={shown}
          visibility={f.visibility}
          touch={touch}
          onToggle={() => onSketchVisibility([f.id], toggledVisibility(shown))}
        />
      ) : null}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        aria-label={`Actions for ${f.name}`}
        onClick={(e) => {
          e.stopPropagation();
          setFocusKey(rowKey);
          setMenu({ key: rowKey, anchor: e.currentTarget });
        }}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-[7px] text-fg-muted hover:bg-surface-3 hover:text-fg',
          touch ? 'mt-0 size-11' : 'mt-0.5 size-7',
          touch ? '' : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
        )}
      >
        <Ellipsis className="size-4" aria-hidden />
      </button>
    </m.div>
  );
}
