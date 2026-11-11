import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginParamDrag,
  getParamDrag,
  PARAM_DRAG_SLOP,
  registerParamDrop,
} from '../src/logic/paramDrag';
import {
  identifierAtCaret,
  insertParam,
  isParamName,
  isPrefixMatch,
  matchParams,
  paramExprFrom,
  paramRefs,
  suggestParamName,
} from '../src/logic/paramLinks';
import { validateNewParamName } from '../src/logic/paramName';

describe('identifierAtCaret', () => {
  it('finds the identifier before the caret and its whole extent', () => {
    expect(identifierAtCaret('wid', 3)).toEqual({ start: 0, end: 3, prefix: 'wid' });
    expect(identifierAtCaret('width/2 + hol', 13)).toEqual({ start: 10, end: 13, prefix: 'hol' });
    // In the middle of a formula, with text after the caret: the whole word is replaced.
    expect(identifierAtCaret('2*wi + 5', 4)).toEqual({ start: 2, end: 4, prefix: 'wi' });
    expect(identifierAtCaret('wid|th'.replace('|', ''), 3)).toEqual({
      start: 0,
      end: 5,
      prefix: 'wid',
    });
  });

  it('is null for numbers, units after a number, and operators', () => {
    expect(identifierAtCaret('25', 2)).toBeNull();
    expect(identifierAtCaret('25mm', 4)).toBeNull();
    expect(identifierAtCaret('25 mm', 5)).toBeNull();
    expect(identifierAtCaret('1.5 in', 6)).toBeNull();
    expect(identifierAtCaret('width + ', 8)).toBeNull();
    expect(identifierAtCaret('', 0)).toBeNull();
  });

  it('offers parameters after an operator or a parenthesis, not after a number', () => {
    expect(identifierAtCaret('3 + w', 5)?.prefix).toBe('w');
    expect(identifierAtCaret('(w', 2)?.prefix).toBe('w');
    expect(identifierAtCaret('2 w', 3)).toBeNull();
  });
});

describe('matchParams', () => {
  const params = [
    { name: 'width', value: '80 mm' },
    { name: 'hole_width' },
    { name: 'depth' },
    { name: 'Wall' },
  ];
  it('ranks prefix matches before substring matches, case-insensitively', () => {
    expect(matchParams(params, 'w').map((p) => p.name)).toEqual(['width', 'Wall', 'hole_width']);
    expect(matchParams(params, 'WID').map((p) => p.name)).toEqual(['width', 'hole_width']);
  });
  it('an empty prefix lists everything; a miss lists nothing', () => {
    expect(matchParams(params, '')).toHaveLength(4);
    expect(matchParams(params, 'zzz')).toEqual([]);
  });
});

describe('matchParams is a hint, never a rewrite', () => {
  it('prefix matches rank first and substring matches are flagged as non-prefix', () => {
    const p = [{ name: 'pitch' }, { name: 'spindle' }, { name: 'width' }];
    expect(matchParams(p, 'pi').map((x) => x.name)).toEqual(['pitch', 'spindle']);
    expect(isPrefixMatch('pitch', 'pi')).toBe(true);
    expect(isPrefixMatch('spindle', 'pi')).toBe(false);
  });
});

describe('insertParam', () => {
  it('replaces the range and puts the caret after the name', () => {
    expect(insertParam('2*wi + 5', 2, 4, 'width')).toEqual({ text: '2*width + 5', caret: 7 });
    expect(insertParam('', 0, 0, 'depth')).toEqual({ text: 'depth', caret: 5 });
  });
});

describe('paramRefs / isParamName', () => {
  const names = ['width', 'mm_gap', 'sin_k'];
  it('finds direct references, in order, once each', () => {
    expect(paramRefs('width/2 + width', names)).toEqual(['width']);
    expect(paramRefs('2*width + mm_gap', names)).toEqual(['width', 'mm_gap']);
  });
  it('ignores units after numbers, calls, and unknown names', () => {
    expect(paramRefs('5mm', ['mm'])).toEqual([]);
    expect(paramRefs('5 mm', ['mm'])).toEqual([]);
    // Engine rule: after a number a name is a unit only if it IS a unit.
    expect(paramRefs('2 width', ['width'])).toEqual(['width']);
    // Number lexing: the exponent of `1e3` / `1e-3` is not a name.
    expect(paramRefs('1e3 + 2.5e-3', ['e3', 'e'])).toEqual([]);
    expect(paramRefs('2 e3', ['e3'])).toEqual(['e3']);
    expect(paramRefs('5width', ['width'])).toEqual(['width']);
    expect(paramRefs('width(2)', ['width'])).toEqual([]);
    expect(paramRefs('depth', names)).toEqual([]);
  });
  it('isParamName is true only for a lone name', () => {
    expect(isParamName(' width ', names)).toBe(true);
    expect(isParamName('width/2', names)).toBe(false);
    expect(isParamName('', names)).toBe(false);
  });
});

describe('paramExprFrom / suggestParamName', () => {
  it('a bare number takes the field unit; an expression is kept', () => {
    expect(paramExprFrom('10', 'mm')).toBe('10 mm');
    expect(paramExprFrom(' 7.5 ', '°')).toBe('7.5 deg');
    expect(paramExprFrom('10mm', 'mm')).toBe('10mm');
    expect(paramExprFrom('width/2', 'mm')).toBe('width/2');
    expect(paramExprFrom('3', undefined)).toBe('3');
  });
  it('suggests a readable, unique, valid name', () => {
    expect(suggestParamName('Extrude depth', [])).toBe('extrude_depth');
    expect(suggestParamName('depth', ['depth'])).toBe('depth_2');
    expect(suggestParamName('depth', ['depth', 'depth_2'])).toBe('depth_3');
    expect(suggestParamName('3 holes', [])).toBe('p_3_holes');
    expect(suggestParamName('  ', [])).toBe('param');
  });
});

describe('validateNewParamName', () => {
  const existing = ['width', 'depth'];
  it('accepts a fresh identifier', () => {
    expect(validateNewParamName('height', existing)).toBeNull();
    expect(validateNewParamName('Höhe_2', existing)).toBeNull();
  });
  it('refuses empty, malformed, duplicate, reserved and unit names', () => {
    expect(validateNewParamName('', existing)).toMatch(/name/);
    expect(validateNewParamName('2fast', existing)).toMatch(/letters/);
    expect(validateNewParamName('a b', existing)).toMatch(/letters/);
    expect(validateNewParamName('width', existing)).toMatch(/already used/);
    expect(validateNewParamName('sin', existing)).toMatch(/built-in/);
    expect(validateNewParamName('pi', existing)).toMatch(/built-in/);
    expect(validateNewParamName('mm', existing)).toMatch(/unit/);
    expect(validateNewParamName('in', existing)).toMatch(/unit/);
  });
});

describe('param drag and drop', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-param-dragging');
  });

  function target() {
    const el = document.createElement('div');
    document.body.append(el);
    const drop = vi.fn();
    registerParamDrop(el, drop);
    // jsdom has no layout: say which element is under the pointer.
    document.elementsFromPoint = () => [el];
    return { el, drop };
  }
  const ev = (type: string, x: number, y: number) =>
    new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true });

  it('drops the parameter name on the target under the pointer', () => {
    const { el, drop } = target();
    const end = vi.fn();
    beginParamDrag({ clientX: 0, clientY: 0, pointerId: 1, button: 0 }, 'width', end);
    window.dispatchEvent(ev('pointermove', 40, 40));
    expect(getParamDrag()).toMatchObject({ name: 'width', over: true });
    expect(el).toHaveAttribute('data-drop-hot');
    expect(document.documentElement).toHaveAttribute('data-param-dragging', 'width');
    window.dispatchEvent(ev('pointerup', 40, 40));
    expect(drop).toHaveBeenCalledWith('width');
    expect(end).toHaveBeenCalledWith(true);
    expect(getParamDrag()).toBeNull();
    expect(el).not.toHaveAttribute('data-drop-hot');
    expect(document.documentElement).not.toHaveAttribute('data-param-dragging');
  });

  it('a press that never leaves the slop is a click, not a drag', () => {
    const { drop } = target();
    beginParamDrag({ clientX: 0, clientY: 0, pointerId: 1 }, 'width');
    window.dispatchEvent(ev('pointermove', PARAM_DRAG_SLOP - 1, 0));
    window.dispatchEvent(ev('pointerup', PARAM_DRAG_SLOP - 1, 0));
    expect(drop).not.toHaveBeenCalled();
    expect(getParamDrag()).toBeNull();
  });

  it('dropping off a target, cancelling and Esc do nothing', () => {
    const { drop } = target();
    beginParamDrag({ clientX: 0, clientY: 0, pointerId: 1 }, 'width');
    window.dispatchEvent(ev('pointermove', 30, 30));
    document.elementsFromPoint = () => [document.body];
    window.dispatchEvent(ev('pointerup', 30, 30));
    expect(drop).not.toHaveBeenCalled();

    document.elementsFromPoint = () => [document.body.firstElementChild as Element];
    beginParamDrag({ clientX: 0, clientY: 0, pointerId: 1 }, 'width');
    window.dispatchEvent(ev('pointermove', 30, 30));
    window.dispatchEvent(ev('pointercancel', 30, 30));
    expect(drop).not.toHaveBeenCalled();

    beginParamDrag({ clientX: 0, clientY: 0, pointerId: 1 }, 'width');
    window.dispatchEvent(ev('pointermove', 30, 30));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(ev('pointerup', 30, 30));
    expect(drop).not.toHaveBeenCalled();
    expect(getParamDrag()).toBeNull();
  });

  it('ignores a right-button press', () => {
    const { drop } = target();
    beginParamDrag({ clientX: 0, clientY: 0, pointerId: 1, button: 2 }, 'width');
    window.dispatchEvent(ev('pointermove', 30, 30));
    window.dispatchEvent(ev('pointerup', 30, 30));
    expect(drop).not.toHaveBeenCalled();
  });
});
