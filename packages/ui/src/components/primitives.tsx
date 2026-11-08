import * as RSeparator from '@radix-ui/react-separator';
import * as RTooltip from '@radix-ui/react-tooltip';
import {
  type ButtonHTMLAttributes,
  createContext,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useContext,
} from 'react';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------------- Tooltip */

const HasProvider = createContext(false);

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={450} skipDelayDuration={250}>
      <HasProvider.Provider value={true}>{children}</HasProvider.Provider>
    </RTooltip.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** Optional shortcut rendered as a keycap next to the label. */
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactNode;
}

function TooltipInner({ content, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={8}
          collisionPadding={8}
          className="z-[var(--z-popover)] flex items-center gap-2 rounded-lg bg-fg px-2.5 py-1.5 text-2xs font-medium text-bg shadow-pop select-none"
        >
          <span>{content}</span>
          {shortcut ? <Kbd inverted>{shortcut}</Kbd> : null}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/** Accessible tooltip. Works with or without a surrounding {@link TooltipProvider}. */
export function Tooltip(props: TooltipProps) {
  const has = useContext(HasProvider);
  return has ? (
    <TooltipInner {...props} />
  ) : (
    <TooltipProvider>
      <TooltipInner {...props} />
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------------- Kbd / Separator */

export function Kbd({
  children,
  inverted,
  className,
}: {
  children: ReactNode;
  inverted?: boolean;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        'tnum inline-flex h-5 min-w-5 items-center justify-center rounded-[6px] px-1 font-sans text-2xs font-medium',
        inverted ? 'bg-bg/15 text-bg' : 'bg-surface-3 text-fg-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  return (
    <RSeparator.Root
      decorative
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-5 w-px self-center',
        className,
      )}
    />
  );
}

/* ------------------------------------------------------------------------- Button */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ControlSize = 'md' | 'touch';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 active:bg-surface-3',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3',
};

const buttonSizes: Record<ControlSize, string> = {
  md: 'h-8 px-3 text-ui',
  touch: 'h-11 px-4 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Leading icon. */
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control font-medium whitespace-nowrap transition-colors duration-fast select-none disabled:opacity-45 aria-disabled:opacity-45',
        variants[variant],
        buttonSizes[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------- IconButton */

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Required accessible name; also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  shortcut?: string;
  /** Toggle state; renders `aria-pressed` and the active look. */
  pressed?: boolean;
  size?: ControlSize;
  variant?: Exclude<ButtonVariant, 'primary'>;
  tooltipSide?: TooltipProps['side'];
  /** Keeps the button focusable (so the tooltip still explains why) but inert. */
  disabled?: boolean;
  /** Extra tooltip text, e.g. "Coming in M1". */
  hint?: string;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  icon,
  shortcut,
  pressed,
  size = 'md',
  variant = 'ghost',
  tooltipSide,
  disabled,
  hint,
  className,
  onClick,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip content={hint ? `${label} — ${hint}` : label} shortcut={shortcut} side={tooltipSide}>
      <button
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        aria-disabled={disabled || undefined}
        onClick={disabled ? (e) => e.preventDefault() : onClick}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-control transition-colors duration-fast select-none aria-disabled:opacity-40',
          size === 'touch' ? 'size-11' : 'size-8',
          pressed
            ? 'bg-accent-soft text-accent-text'
            : variant === 'secondary'
              ? 'bg-surface-2 text-fg hover:bg-surface-3'
              : 'text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3',
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------------- Panel */

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  /** `floating` = translucent + blur over the viewport; `docked` = opaque card. */
  variant?: 'floating' | 'docked';
}

/** Floating translucent panel (blur on capable devices), or an opaque docked card. */
export function Panel({
  as: As = 'div',
  variant = 'floating',
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <As className={cn(variant === 'floating' ? 'w-panel' : 'w-card', className)} {...rest}>
      {children}
    </As>
  );
}
