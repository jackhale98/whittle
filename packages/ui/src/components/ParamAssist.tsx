/**
 * Parameter assistance for a value field (ADR-080), loaded the first time a field has parameters
 * to offer, so none of it is on the initial route: the autocomplete combobox, the fx button, the
 * "Make parameter" form, the link badge and the drop target. `ExpressionInput` owns the text; this
 * owns the list state and talks back through `api` (keys, changes, blur) and `onState` (ARIA).
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { registerParamDrop } from '../logic/paramDrag';
import {
  type AssistApi,
  type AssistState,
  identifierAtCaret,
  insertParam,
  isParamName,
  matchParams,
  optionId,
  type ParamInfo,
  type PickerEntry,
  paramExprFrom,
  paramRefs,
  suggestParamName,
} from '../logic/paramLinks';
import { MakeParamForm, ParamList } from './ParamPicker';
import { ParamLinksContext, ParamNamesContext } from './paramNames';
import { cn } from './primitives';

export interface ParamAssistProps {
  api: { current: AssistApi };
  input: { current: HTMLInputElement | null };
  box: HTMLElement;
  startSlot: HTMLElement | null;
  endSlot: HTMLElement | null;
  text: string;
  sel: readonly [number, number];
  focused: boolean;
  paramNames: readonly string[] | undefined;
  paramLinks: 'full' | 'complete';
  /** The field's value is valid (a parameter can be made from it). */
  valid: boolean;
  unitHint: string | undefined;
  label: string;
  size: 'md' | 'touch';
  disabled: boolean;
  keypadOn: boolean;
  closeKeypad(): void;
  edit(next: string): void;
  /** The new parameter exists: commit its name into the field. */
  onMade(name: string): void;
  onDrop(name: string): void;
  /** Ends the edit like a blur (commits a valid draft). */
  leave(): void;
  linkId: string;
  listId: string;
  onState(s: AssistState): void;
}

export default function ParamAssist(p: ParamAssistProps) {
  const { text, sel, focused, input, box } = p;
  const links = useContext(ParamLinksContext);
  const ctxNames = useContext(ParamNamesContext);
  const popup = useRef<HTMLDivElement>(null);
  // `openAll`: the whole list was asked for (fx, `=`, Alt+↓) and stays until the text changes.
  const [openAll, setOpenAll] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [making, setMaking] = useState(false);

  const infos = useMemo<readonly ParamInfo[]>(() => {
    if (!p.paramNames) {
      return links.params.length > 0 ? links.params : ctxNames.map((name) => ({ name }));
    }
    return p.paramNames.map((name) => links.params.find((x) => x.name === name) ?? { name });
  }, [p.paramNames, links.params, ctxNames]);
  const nameList = useMemo(() => infos.map((x) => x.name), [infos]);
  const refs = useMemo(() => paramRefs(text, nameList), [text, nameList]);
  const canMake =
    p.paramLinks === 'full' &&
    !!links.make &&
    p.valid &&
    !!text.trim() &&
    !isParamName(text, nameList);

  const ident = sel[0] === sel[1] ? identifierAtCaret(text, sel[1]) : null;
  const typed = ident?.prefix ?? '';
  const matches = useMemo(() => matchParams(infos, openAll ? '' : typed), [infos, openAll, typed]);
  const autoOpen =
    focused &&
    !dismissed &&
    !!ident &&
    matches.length > 0 &&
    !(matches.length === 1 && matches[0]?.name === ident.prefix);
  const entries = useMemo<PickerEntry[]>(() => {
    const out: PickerEntry[] = matches.map((info) => ({ kind: 'param', info }));
    if (openAll && canMake) out.push({ kind: 'make', text: text.trim() });
    return out;
  }, [matches, openAll, canMake, text]);
  const listOpen =
    !making && (openAll || autoOpen) && entries.length > 0 && (!p.keypadOn || openAll);
  const activeIdx = Math.min(active, Math.max(0, entries.length - 1));
  const activeEntry = entries[activeIdx];
  const fxOpen = listOpen && openAll;
  const linked = refs.length > 0 ? refs.join(', ') : null;

  const { onState } = p;
  const activeId = listOpen ? optionId(p.listId, activeIdx) : undefined;
  useEffect(() => {
    onState({ listOpen, listId: p.listId, activeId, linked });
  }, [onState, listOpen, p.listId, activeId, linked]);
  useEffect(
    () => () => onState({ listOpen: false, listId: p.listId, linked: null }),
    [onState, p.listId],
  );

  function restoreCaret(pos: number) {
    const el = input.current;
    requestAnimationFrame(() => el?.setSelectionRange(pos, pos));
  }

  /** Puts a parameter's name into the text: the selection, else the identifier at the caret. */
  function accept(name: string) {
    const el = input.current;
    const a = el?.selectionStart ?? text.length;
    const b = el?.selectionEnd ?? a;
    let range: [number, number] = [a, b];
    if (a === b) {
      const id = identifierAtCaret(text, a);
      if (id) range = [id.start, id.end];
    }
    const r = insertParam(text, range[0], range[1], name);
    p.edit(r.text);
    setDismissed(true);
    restoreCaret(r.caret);
    el?.focus();
  }

  function pick(entry: PickerEntry | undefined) {
    if (!entry) return;
    if (entry.kind === 'make') {
      setOpenAll(false);
      setMaking(true);
    } else accept(entry.info.name);
  }

  function openList() {
    if (p.keypadOn) p.closeKeypad();
    setOpenAll(true);
    setDismissed(false);
    setActive(0);
    input.current?.focus();
  }

  function make(name: string): string | undefined {
    const err = links.make?.(name, paramExprFrom(text, p.unitHint));
    if (err) return err;
    p.onMade(name);
    links.makeDone?.();
    setMaking(false);
    input.current?.focus();
    return undefined;
  }

  // The field is a drop target for a parameter dragged from the Params tab.
  const dropRef = useRef(p.onDrop);
  dropRef.current = p.onDrop;
  const droppable = p.paramLinks === 'full' && !p.disabled;
  useEffect(() => {
    if (!droppable) return;
    return registerParamDrop(box, (n) => dropRef.current(n));
  }, [box, droppable]);

  // An outside press ends the make form (committing like a blur would) or closes the full list.
  const leaveRef = useRef(p.leave);
  leaveRef.current = p.leave;
  useEffect(() => {
    if (!making && !fxOpen) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popup.current?.contains(t) || box.contains(t)) return;
      if (making) {
        setMaking(false);
        leaveRef.current();
      } else setOpenAll(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [making, fxOpen, box]);

  const state = useRef({ listOpen, entries, activeIdx, activeEntry, typed, openAll, canMake });
  state.current = { listOpen, entries, activeIdx, activeEntry, typed, openAll, canMake };
  const fns = useRef({ pick, openList });
  fns.current = { pick, openList };
  const { api } = p;
  useEffect(() => {
    api.current = {
      onKeyDown(e) {
        const s = state.current;
        if (s.listOpen) {
          const n = s.entries.length;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setActive((s.activeIdx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
            return true;
          }
          if (e.key === 'Escape') {
            // Closes the list only: the edit stays (a second Esc reverts it).
            e.preventDefault();
            e.stopPropagation();
            setOpenAll(false);
            setDismissed(true);
            return true;
          }
          if ((e.key === 'Enter' || e.key === 'Tab') && s.activeEntry && !e.shiftKey) {
            const same =
              s.activeEntry.kind === 'param' && !s.openAll && s.activeEntry.info.name === s.typed;
            // Enter on a name that is already complete commits as usual.
            if (!(same && e.key === 'Enter')) {
              e.preventDefault();
              e.stopPropagation();
              fns.current.pick(s.activeEntry);
              return true;
            }
          }
        } else if (e.altKey && e.key === 'ArrowDown') {
          e.preventDefault();
          fns.current.openList();
          return true;
        }
        return false;
      },
      onChange(next, caret, prev) {
        // `=` typed at the start is the spreadsheet "formula" gesture: drop it, list the parameters.
        if (next.startsWith('=') && !prev.startsWith('=') && caret === 1) {
          p.edit(next.slice(1));
          setOpenAll(true);
          restoreCaret(0);
          return true;
        }
        return false;
      },
      onEdit() {
        setDismissed(false);
        setOpenAll(false);
        setActive(0);
      },
      onBlur(related) {
        if (popup.current?.contains(related)) return true;
        setOpenAll(false);
        return making;
      },
    };
  });
  useEffect(
    () => () => {
      api.current = {};
    },
    [api],
  );

  const tall = p.size === 'touch';
  return (
    <>
      {p.startSlot
        ? createPortal(
            <>
              {linked ? (
                <>
                  <span
                    aria-hidden
                    data-testid="param-link-badge"
                    title={`Linked to ${linked}`}
                    className="-ml-1 shrink-0 rounded-[5px] bg-accent-soft px-1 text-2xs font-semibold text-accent-text italic"
                  >
                    fx
                  </span>
                  <span id={p.linkId} className="sr-only">
                    Linked to {refs.length === 1 ? 'parameter' : 'parameters'} {linked}
                  </span>
                </>
              ) : null}
            </>,
            p.startSlot,
          )
        : null}
      {p.endSlot
        ? createPortal(
            <button
              type="button"
              // Keyboard users have Alt+↓ and `=`; the button keeps the tab order short.
              tabIndex={-1}
              data-testid="param-fx"
              aria-label={`Parameters for ${p.label}`}
              aria-haspopup="listbox"
              aria-expanded={fxOpen}
              aria-controls={fxOpen ? p.listId : undefined}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (fxOpen ? setOpenAll(false) : openList())}
              className={cn(
                '-mr-1.5 flex shrink-0 items-center justify-center rounded-[6px] text-xs font-semibold text-fg-subtle italic hover:bg-surface-3 hover:text-fg',
                tall ? 'h-full min-w-11' : 'h-6 min-w-6 px-1',
                fxOpen && 'bg-accent-soft text-accent-text',
              )}
            >
              fx
            </button>,
            p.endSlot,
          )
        : null}
      {listOpen ? (
        <ParamList
          anchor={box}
          popup={popup}
          listId={p.listId}
          entries={entries}
          active={activeIdx}
          onActive={setActive}
          onPick={pick}
          size={p.size}
        />
      ) : null}
      {making ? (
        <MakeParamForm
          anchor={box}
          popup={popup}
          initial={suggestParamName(p.label, nameList)}
          expr={paramExprFrom(text, p.unitHint)}
          existing={nameList}
          onMake={make}
          onCancel={() => {
            setMaking(false);
            input.current?.focus();
          }}
          size={p.size}
        />
      ) : null}
    </>
  );
}
