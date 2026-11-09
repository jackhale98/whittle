// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tokenizer and Pratt parser for Wren expressions. Hand-written; no `eval`, no `Function`.
 *
 * Grammar (precedence low → high):
 *   additive   :=  term (('+' | '-') term)*
 *   term       :=  unary (('*' | '/' | implicit) unary)*      implicit = juxtaposition: `25mm`, `2 width`
 *   unary      :=  ('-' | '+') unary | power
 *   power      :=  primary ('^' unary)?                          right-associative; `-2^2` = -(2^2)
 *   primary    :=  number | identifier | identifier '(' args ')' | '(' additive ')'
 *
 * Unit suffixes are ordinary identifiers: `25mm` is `25 * mm`, `2.7 g/cm^3` is `(2.7 * g) / (cm ^ 3)`.
 */

export type Span = [start: number, end: number];

export class ExprSyntaxError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
    this.name = 'ExprSyntaxError';
  }
}

export type Token =
  | { k: 'num'; v: number; s: number; e: number }
  | { k: 'id'; name: string; s: number; e: number }
  | { k: 'op'; op: '+' | '-' | '*' | '/' | '^' | '(' | ')' | ','; s: number; e: number }
  | { k: 'eof'; s: number; e: number };

const OP_ALIASES: Record<string, '+' | '-' | '*' | '/' | '^' | '(' | ')' | ','> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '–': '-',
  '*': '*',
  '×': '*',
  '·': '*',
  '/': '/',
  '÷': '/',
  '^': '^',
  '(': '(',
  ')': ')',
  ',': ',',
};

const ID_START = /[\p{L}_µ°]/u;
const ID_PART = /[\p{L}\p{N}_µ]/u;
const DIGIT = /[0-9]/;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      const m = NUMBER.exec(src.slice(i));
      if (!m) throw new ExprSyntaxError(`Invalid number near ‘${ch}’`, [i, i + 1]);
      out.push({ k: 'num', v: Number(m[0]), s: i, e: i + m[0].length });
      i += m[0].length;
      continue;
    }
    // Inch / foot marks are unit suffixes: 25" and 3'.
    if (ch === '"' || ch === '″' || ch === '”') {
      out.push({ k: 'id', name: 'in', s: i, e: i + 1 });
      i++;
      continue;
    }
    if (ch === "'" || ch === '′' || ch === '’') {
      out.push({ k: 'id', name: 'ft', s: i, e: i + 1 });
      i++;
      continue;
    }
    if (ID_START.test(ch)) {
      let j = i + 1;
      // `°` is a complete unit on its own.
      if (ch !== '°') while (j < src.length && ID_PART.test(src[j] as string)) j++;
      out.push({ k: 'id', name: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    const op = OP_ALIASES[ch];
    if (op) {
      out.push({ k: 'op', op, s: i, e: i + 1 });
      i++;
      continue;
    }
    throw new ExprSyntaxError(`Unexpected character ‘${ch}’`, [i, i + 1]);
  }
  out.push({ k: 'eof', s: src.length, e: src.length });
  return out;
}

// ---------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------

export type Node =
  | { t: 'num'; v: number; span: Span }
  | {
      t: 'id';
      name: string;
      span: Span;
      /** Directly follows a number token (`25mm`): a unit is expected, so units win over params. */
      afterNumber: boolean;
    }
  | { t: 'unary'; op: '-' | '+'; x: Node; span: Span }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node; span: Span; implicit: boolean }
  | { t: 'call'; name: string; nameSpan: Span; args: Node[]; span: Span };

const PREC_ADD = 10;
const PREC_MUL = 20;
const PREC_UNARY = 30;
const PREC_POW = 40;

class Parser {
  private pos = 0;
  constructor(
    private readonly toks: Token[],
    private readonly src: string,
  ) {}

  private peek(): Token {
    return this.toks[this.pos] as Token;
  }

  private next(): Token {
    const t = this.toks[this.pos] as Token;
    if (t.k !== 'eof') this.pos++;
    return t;
  }

  private text(t: Token): string {
    return t.k === 'eof' ? 'end of expression' : `‘${this.src.slice(t.s, t.e)}’`;
  }

  parseAll(): Node {
    const n = this.parseExpr(0);
    const t = this.peek();
    if (t.k !== 'eof') {
      if (t.k === 'op' && t.op === ')') {
        throw new ExprSyntaxError('Unmatched closing parenthesis ‘)’', [t.s, t.e]);
      }
      if (t.k === 'num') {
        throw new ExprSyntaxError(
          `Unexpected number ${this.text(t)} — missing an operator or unit?`,
          [t.s, t.e],
        );
      }
      throw new ExprSyntaxError(`Unexpected ${this.text(t)}`, [t.s, t.e]);
    }
    return n;
  }

  private parseExpr(minPrec: number): Node {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && (t.op === '+' || t.op === '-')) {
        if (PREC_ADD < minPrec) break;
        this.next();
        const right = this.parseExpr(PREC_ADD + 1);
        left = {
          t: 'bin',
          op: t.op,
          a: left,
          b: right,
          span: [left.span[0], right.span[1]],
          implicit: false,
        };
        continue;
      }
      if (t.k === 'op' && (t.op === '*' || t.op === '/')) {
        if (PREC_MUL < minPrec) break;
        this.next();
        const right = this.parseExpr(PREC_MUL + 1);
        left = {
          t: 'bin',
          op: t.op,
          a: left,
          b: right,
          span: [left.span[0], right.span[1]],
          implicit: false,
        };
        continue;
      }
      if (t.k === 'op' && t.op === '^') {
        if (PREC_POW < minPrec) break;
        this.next();
        // Right-associative; the exponent may itself carry a sign: 2^-3.
        const right = this.parseExpr(PREC_POW);
        left = {
          t: 'bin',
          op: '^',
          a: left,
          b: right,
          span: [left.span[0], right.span[1]],
          implicit: false,
        };
        continue;
      }
      // Implicit multiplication: a value directly followed by an identifier or '('.
      if (t.k === 'id' || (t.k === 'op' && t.op === '(')) {
        if (PREC_MUL < minPrec) break;
        const right = this.parseExpr(PREC_MUL + 1);
        left = {
          t: 'bin',
          op: '*',
          a: left,
          b: right,
          span: [left.span[0], right.span[1]],
          implicit: true,
        };
        continue;
      }
      break;
    }
    return left;
  }

  private parsePrefix(): Node {
    const t = this.next();
    switch (t.k) {
      case 'num':
        return { t: 'num', v: t.v, span: [t.s, t.e] };
      case 'id': {
        const nt = this.peek();
        if (nt.k === 'op' && nt.op === '(') return this.parseCall(t);
        const prev = this.toks[this.pos - 2];
        return {
          t: 'id',
          name: t.name,
          span: [t.s, t.e],
          afterNumber: prev !== undefined && prev.k === 'num',
        };
      }
      case 'op': {
        if (t.op === '-' || t.op === '+') {
          const x = this.parseExpr(PREC_UNARY);
          return { t: 'unary', op: t.op, x, span: [t.s, x.span[1]] };
        }
        if (t.op === '(') {
          const inner = this.parseExpr(0);
          const close = this.peek();
          if (close.k !== 'op' || close.op !== ')') {
            throw new ExprSyntaxError('Missing closing parenthesis ‘)’', [t.s, t.e]);
          }
          this.next();
          return { ...inner, span: [t.s, close.e] };
        }
        throw new ExprSyntaxError(`Unexpected ${this.text(t)} — expected a value`, [t.s, t.e]);
      }
      case 'eof':
        throw new ExprSyntaxError(
          this.src.trim() === '' ? 'Empty expression' : 'Expression ends early — expected a value',
          [t.s, t.e],
        );
    }
  }

  private parseCall(nameTok: Token & { k: 'id' }): Node {
    const open = this.next(); // '('
    const args: Node[] = [];
    const close0 = this.peek();
    if (close0.k === 'op' && close0.op === ')') {
      this.next();
      return {
        t: 'call',
        name: nameTok.name,
        nameSpan: [nameTok.s, nameTok.e],
        args,
        span: [nameTok.s, close0.e],
      };
    }
    for (;;) {
      args.push(this.parseExpr(0));
      const t = this.next();
      if (t.k === 'op' && t.op === ',') continue;
      if (t.k === 'op' && t.op === ')') {
        return {
          t: 'call',
          name: nameTok.name,
          nameSpan: [nameTok.s, nameTok.e],
          args,
          span: [nameTok.s, t.e],
        };
      }
      throw new ExprSyntaxError(`Missing closing parenthesis ‘)’ for ${nameTok.name}(`, [
        open.s,
        open.e,
      ]);
    }
  }
}

export function parse(src: string): Node {
  return new Parser(tokenize(src), src).parseAll();
}

/** Identifier tokens of an expression (used for rename refactoring). */
export function identifierSpans(src: string): { name: string; span: Span; call: boolean }[] {
  const toks = tokenize(src);
  const out: { name: string; span: Span; call: boolean }[] = [];
  toks.forEach((t, i) => {
    if (t.k !== 'id') return;
    const n = toks[i + 1];
    out.push({ name: t.name, span: [t.s, t.e], call: n?.k === 'op' && n.op === '(' });
  });
  return out;
}
