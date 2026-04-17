/**
 * HCL2 lexer. Produces a flat array of Token records from a SourceFile.
 *
 * The lexer is mode-tracking: it maintains a stack of lex modes so that
 * context-sensitive tokens (quoted strings, template interpolations, heredoc
 * bodies, control sequences) can be disambiguated without parser feedback.
 * Modes are described in docs/design.md §5.2.
 *
 * Trivia model (docs/design.md §5.4): every token carries the whitespace,
 * comments, and bracket-suppressed newlines that precede its lexeme as
 * `leadingTrivia`, plus any same-line whitespace / same-line comment after
 * its lexeme as `trailingTrivia`. Concatenating
 * `leadingTrivia + lexeme + trailingTrivia` across every token (including
 * the final EOF) reproduces the input source byte-for-byte. The lex tests
 * verify this invariant on every fixture.
 *
 * Newline handling: real `\n` / `\r\n` / `\r` terminators emit NEWLINE
 * tokens at the top level so the parser can use them as statement
 * terminators. Inside balanced `(...)` and `[...]`, and inside
 * `${...}` / `%{...}` interpolations, newlines are treated as whitespace
 * and absorbed into leading trivia. Braces (`{...}`) do NOT suppress
 * newlines at the lexer level; the parser decides later whether a given
 * brace pair is a block body (newlines significant) or an object literal
 * (newlines ignored).
 */

import type { Position, Range, SourceFile } from "../source.js";
import { isIdContinue, isIdStart } from "../unicode.js";
import type { Token } from "./token.js";
import { TokenKind } from "./token.js";

interface ModeFrame {
  kind: "NORMAL" | "TEMPLATE" | "TEMPLATE_INTERP" | "TEMPLATE_CONTROL";
  /** Populated only when kind === "TEMPLATE" for a heredoc body. */
  heredoc?: { delimiter: string; strip: boolean };
  /**
   * Brace nesting depth for TEMPLATE_INTERP / TEMPLATE_CONTROL. Starts at
   * 0 when the mode is pushed; each `{` increments, each `}` decrements.
   * When a `}` is seen at depth 0, the mode pops and TEMPLATE_SEQ_END is
   * emitted.
   */
  braceDepth: number;
}

const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const HASH = 0x23;
const SLASH = 0x2f;
const STAR = 0x2a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const DOLLAR = 0x24;
const PERCENT = 0x25;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const TILDE = 0x7e;
const LT = 0x3c;
const MINUS = 0x2d;

/** Public entry point. Lex the given source file into a token array. */
export function lex(source: SourceFile): Token[] {
  return new Lexer(source).tokenize();
}

export class Lexer {
  private readonly source: SourceFile;
  private readonly text: string;
  private pos = 0;
  private readonly modes: ModeFrame[] = [{ kind: "NORMAL", braceDepth: 0 }];
  /**
   * Stack of open parenthesis / bracket kinds, for newline suppression.
   * Braces are not pushed here — they are handled by the mode stack
   * (TEMPLATE_INTERP / TEMPLATE_CONTROL) because their meaning depends on
   * context the lexer cannot determine on its own.
   */
  private readonly brackets: number[] = [];

  constructor(source: SourceFile) {
    this.source = source;
    this.text = source.text;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const token = this.nextToken();
      tokens.push(token);
      if (token.kind === TokenKind.EOF) break;
    }
    return tokens;
  }

  private currentMode(): ModeFrame {
    return this.modes[this.modes.length - 1]!;
  }

  private shouldSuppressNewlines(): boolean {
    const top = this.currentMode();
    if (top.kind === "TEMPLATE_INTERP" || top.kind === "TEMPLATE_CONTROL") {
      return true;
    }
    if (top.kind === "NORMAL" && this.brackets.length > 0) return true;
    return false;
  }

  private nextToken(): Token {
    const mode = this.currentMode();
    if (mode.kind === "TEMPLATE") {
      return this.templateToken();
    }
    return this.normalToken();
  }

  /** Build a Token record, computing range from start/end offsets. */
  private make(
    kind: TokenKind,
    leadingStart: number,
    lexemeStart: number,
    lexemeEnd: number,
    trailingEnd: number,
    error?: string,
  ): Token {
    const start: Position = this.source.positionOf(lexemeStart);
    const end: Position = this.source.positionOf(lexemeEnd);
    const range: Range = { start, end };
    const token: Token = {
      kind,
      lexeme: this.text.slice(lexemeStart, lexemeEnd),
      leadingTrivia: this.text.slice(leadingStart, lexemeStart),
      trailingTrivia: this.text.slice(lexemeEnd, trailingEnd),
      range,
      ...(error !== undefined ? { error } : {}),
    };
    return token;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trivia skipping
  // ─────────────────────────────────────────────────────────────────────────

  private skipLeadingTrivia(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === SPACE || c === TAB) {
        this.pos++;
        continue;
      }
      if ((c === LF || c === CR) && this.shouldSuppressNewlines()) {
        if (c === CR && this.text.charCodeAt(this.pos + 1) === LF) this.pos++;
        this.pos++;
        continue;
      }
      if (c === HASH) {
        this.skipLineComment();
        continue;
      }
      if (c === SLASH) {
        const next = this.text.charCodeAt(this.pos + 1);
        if (next === SLASH) {
          this.skipLineComment();
          continue;
        }
        if (next === STAR) {
          this.skipBlockComment();
          continue;
        }
      }
      break;
    }
  }

  /**
   * Skip same-line trivia following a token. Stops at newlines (which are
   * either NEWLINE tokens or content), at non-trivia characters, and at
   * block comments that would cross a newline (those belong to the next
   * token's leading trivia, not this token's trailing trivia).
   */
  private skipTrailingTrivia(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === SPACE || c === TAB) {
        this.pos++;
        continue;
      }
      if (c === HASH) {
        this.skipLineComment();
        break; // line comment runs to EOL, nothing more can be trailing
      }
      if (c === SLASH) {
        const next = this.text.charCodeAt(this.pos + 1);
        if (next === SLASH) {
          this.skipLineComment();
          break;
        }
        if (next === STAR && this.blockCommentEndsOnSameLine(this.pos)) {
          this.skipBlockComment();
          continue;
        }
      }
      break;
    }
  }

  /** Advance past a `#` or `//` comment up to (not including) the newline. */
  private skipLineComment(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === LF || c === CR) break;
      this.pos++;
    }
  }

  /** Advance past a `/* ... *\/` comment. If unterminated, consume to EOF. */
  private skipBlockComment(): void {
    this.pos += 2; // consume opening `/*`
    while (this.pos < this.text.length) {
      if (
        this.text.charCodeAt(this.pos) === STAR &&
        this.text.charCodeAt(this.pos + 1) === SLASH
      ) {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
  }

  /** True iff a `/*...*\/` comment starting at `from` closes on the same line. */
  private blockCommentEndsOnSameLine(from: number): boolean {
    let i = from + 2;
    while (i < this.text.length - 1) {
      const c = this.text.charCodeAt(i);
      if (c === LF || c === CR) return false;
      if (c === STAR && this.text.charCodeAt(i + 1) === SLASH) return true;
      i++;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NORMAL / TEMPLATE_INTERP / TEMPLATE_CONTROL scanning
  // ─────────────────────────────────────────────────────────────────────────

  private normalToken(): Token {
    const leadingStart = this.pos;
    this.skipLeadingTrivia();
    const lexemeStart = this.pos;

    if (lexemeStart >= this.text.length) {
      // EOF has no lexeme, no trailing trivia.
      return this.make(
        TokenKind.EOF,
        leadingStart,
        lexemeStart,
        lexemeStart,
        lexemeStart,
      );
    }

    const c = this.text.charCodeAt(lexemeStart);
    const { kind, error } = this.scanNormalLexeme(c);
    const lexemeEnd = this.pos;
    // A NEWLINE lexeme ends on a new line, so anything that follows is on a
    // different line and cannot be same-line trailing trivia. Leave it for
    // the next token's leading trivia.
    if (kind !== TokenKind.NEWLINE) this.skipTrailingTrivia();
    const trailingEnd = this.pos;

    return this.make(kind, leadingStart, lexemeStart, lexemeEnd, trailingEnd, error);
  }

  private scanNormalLexeme(c: number): { kind: TokenKind; error?: string } {
    // Newline at top level (only reached when suppression is off).
    if (c === LF || c === CR) {
      if (c === CR && this.text.charCodeAt(this.pos + 1) === LF) this.pos++;
      this.pos++;
      return { kind: TokenKind.NEWLINE };
    }

    // String literal opener.
    if (c === QUOTE) {
      this.pos++;
      this.pushMode({ kind: "TEMPLATE", braceDepth: 0 });
      return { kind: TokenKind.OQUOTE };
    }

    // Heredoc opener (<< or <<-).
    if (c === LT && this.text.charCodeAt(this.pos + 1) === LT) {
      const heredoc = this.tryScanHeredocBegin();
      if (heredoc) return heredoc;
    }

    // Close brace in a template-interp/control context pops the mode.
    if (c === RBRACE) {
      const mode = this.currentMode();
      if (
        (mode.kind === "TEMPLATE_INTERP" || mode.kind === "TEMPLATE_CONTROL") &&
        mode.braceDepth === 0
      ) {
        this.pos++;
        this.popMode();
        return { kind: TokenKind.TEMPLATE_SEQ_END };
      }
      if (mode.kind === "TEMPLATE_INTERP" || mode.kind === "TEMPLATE_CONTROL") {
        mode.braceDepth--;
      }
      this.pos++;
      return { kind: TokenKind.RBRACE };
    }

    // Strip markers (~) immediately inside ${~ ... ~} or %{~ ... ~}.
    // The parser distinguishes strip-on-enter vs strip-on-exit based on
    // position; here we only emit the TEMPLATE_STRIP token kind.
    if (c === TILDE) {
      const mode = this.currentMode();
      if (mode.kind === "TEMPLATE_INTERP" || mode.kind === "TEMPLATE_CONTROL") {
        this.pos++;
        return { kind: TokenKind.TEMPLATE_STRIP };
      }
      // Outside a template sequence, `~` is not a valid token.
      this.pos++;
      return { kind: TokenKind.INVALID, error: "unexpected character '~'" };
    }

    if (c === LBRACE) {
      const mode = this.currentMode();
      if (mode.kind === "TEMPLATE_INTERP" || mode.kind === "TEMPLATE_CONTROL") {
        mode.braceDepth++;
      }
      this.pos++;
      return { kind: TokenKind.LBRACE };
    }

    // Other single- and multi-character punctuation / operators.
    const punct = this.scanPunctuation(c);
    if (punct) return punct;

    // Numbers
    if (c >= 0x30 && c <= 0x39) {
      return this.scanNumber();
    }

    // Identifiers
    if (isIdStartCode(this.text, this.pos)) {
      return this.scanIdent();
    }

    // Unknown character — emit an INVALID token and consume one code point.
    const offset = this.pos;
    this.advanceCodePoint();
    return {
      kind: TokenKind.INVALID,
      error: `unexpected character ${JSON.stringify(this.text.slice(offset, this.pos))}`,
    };
  }

  private scanPunctuation(c: number): { kind: TokenKind } | null {
    switch (c) {
      case 0x28 /* ( */:
        this.pos++;
        this.brackets.push(c);
        return { kind: TokenKind.LPAREN };
      case 0x29 /* ) */:
        this.pos++;
        this.brackets.pop();
        return { kind: TokenKind.RPAREN };
      case 0x5b /* [ */:
        this.pos++;
        this.brackets.push(c);
        return { kind: TokenKind.LBRACK };
      case 0x5d /* ] */:
        this.pos++;
        this.brackets.pop();
        return { kind: TokenKind.RBRACK };
      case 0x2c /* , */:
        this.pos++;
        return { kind: TokenKind.COMMA };
      case 0x3a /* : */:
        this.pos++;
        return { kind: TokenKind.COLON };
      case 0x3f /* ? */:
        this.pos++;
        return { kind: TokenKind.QUESTION };
      case 0x2e /* . */: {
        if (
          this.text.charCodeAt(this.pos + 1) === 0x2e &&
          this.text.charCodeAt(this.pos + 2) === 0x2e
        ) {
          this.pos += 3;
          return { kind: TokenKind.ELLIPSIS };
        }
        this.pos++;
        return { kind: TokenKind.DOT };
      }
      case 0x2b /* + */:
        this.pos++;
        return { kind: TokenKind.PLUS };
      case MINUS /* - */:
        this.pos++;
        return { kind: TokenKind.MINUS };
      case STAR /* * */:
        this.pos++;
        return { kind: TokenKind.STAR };
      case SLASH /* / */:
        this.pos++;
        return { kind: TokenKind.SLASH };
      case PERCENT /* % */:
        this.pos++;
        return { kind: TokenKind.PERCENT };
      case 0x21 /* ! */:
        if (this.text.charCodeAt(this.pos + 1) === 0x3d) {
          this.pos += 2;
          return { kind: TokenKind.NEQ };
        }
        this.pos++;
        return { kind: TokenKind.BANG };
      case 0x3d /* = */: {
        const next = this.text.charCodeAt(this.pos + 1);
        if (next === 0x3d) {
          this.pos += 2;
          return { kind: TokenKind.EQ };
        }
        if (next === 0x3e) {
          this.pos += 2;
          return { kind: TokenKind.FATARROW };
        }
        this.pos++;
        return { kind: TokenKind.ASSIGN };
      }
      case LT /* < */: {
        if (this.text.charCodeAt(this.pos + 1) === 0x3d) {
          this.pos += 2;
          return { kind: TokenKind.LE };
        }
        this.pos++;
        return { kind: TokenKind.LT };
      }
      case 0x3e /* > */: {
        if (this.text.charCodeAt(this.pos + 1) === 0x3d) {
          this.pos += 2;
          return { kind: TokenKind.GE };
        }
        this.pos++;
        return { kind: TokenKind.GT };
      }
      case 0x26 /* & */:
        if (this.text.charCodeAt(this.pos + 1) === 0x26) {
          this.pos += 2;
          return { kind: TokenKind.AND };
        }
        return null;
      case 0x7c /* | */:
        if (this.text.charCodeAt(this.pos + 1) === 0x7c) {
          this.pos += 2;
          return { kind: TokenKind.OR };
        }
        return null;
    }
    return null;
  }

  private scanNumber(): { kind: TokenKind } {
    while (isDigit(this.text.charCodeAt(this.pos))) this.pos++;
    // Fractional part: `.` followed by digit.
    if (
      this.text.charCodeAt(this.pos) === 0x2e &&
      isDigit(this.text.charCodeAt(this.pos + 1))
    ) {
      this.pos++;
      while (isDigit(this.text.charCodeAt(this.pos))) this.pos++;
    }
    // Exponent: [eE] [+-]? digit+.
    const expMark = this.text.charCodeAt(this.pos);
    if (expMark === 0x65 || expMark === 0x45) {
      let next = this.pos + 1;
      const sign = this.text.charCodeAt(next);
      if (sign === 0x2b || sign === MINUS) next++;
      if (isDigit(this.text.charCodeAt(next))) {
        this.pos = next;
        while (isDigit(this.text.charCodeAt(this.pos))) this.pos++;
      }
    }
    return { kind: TokenKind.NUMBER };
  }

  private scanIdent(): { kind: TokenKind } {
    this.advanceCodePoint();
    while (this.pos < this.text.length) {
      if (!isIdContinueCode(this.text, this.pos)) break;
      this.advanceCodePoint();
    }
    return { kind: TokenKind.IDENT };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Heredocs
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Try to parse a heredoc opener starting at `<<` or `<<-`. If the pattern
   * doesn't match, returns null and leaves `pos` unchanged (caller will
   * re-process the `<` as a LT punctuation token).
   */
  private tryScanHeredocBegin():
    | { kind: TokenKind; error?: string }
    | null {
    const save = this.pos;
    this.pos += 2; // consume `<<`
    let strip = false;
    if (this.text.charCodeAt(this.pos) === MINUS) {
      strip = true;
      this.pos++;
    }
    const identStart = this.pos;
    if (!isIdStartCode(this.text, this.pos)) {
      this.pos = save;
      return null;
    }
    this.advanceCodePoint();
    while (this.pos < this.text.length && isIdContinueCode(this.text, this.pos)) {
      this.advanceCodePoint();
    }
    const delimiter = this.text.slice(identStart, this.pos);
    // Require newline after delimiter (consumed as part of HEREDOC_BEGIN).
    const nlChar = this.text.charCodeAt(this.pos);
    if (nlChar === CR && this.text.charCodeAt(this.pos + 1) === LF) {
      this.pos += 2;
    } else if (nlChar === LF || nlChar === CR) {
      this.pos++;
    } else {
      // Not a well-formed heredoc; back out and let caller handle `<<` as LT LT.
      this.pos = save;
      return null;
    }
    this.pushMode({ kind: "TEMPLATE", heredoc: { delimiter, strip }, braceDepth: 0 });
    return { kind: TokenKind.HEREDOC_BEGIN };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEMPLATE mode — quoted strings and heredoc bodies
  // ─────────────────────────────────────────────────────────────────────────

  private templateToken(): Token {
    const leadingStart = this.pos;
    // No trivia is stripped inside templates — every character is content
    // until we hit a structural marker.
    const lexemeStart = this.pos;

    if (lexemeStart >= this.text.length) {
      return this.make(
        TokenKind.EOF,
        leadingStart,
        lexemeStart,
        lexemeStart,
        lexemeStart,
        "unterminated template",
      );
    }

    const mode = this.currentMode();
    const c = this.text.charCodeAt(lexemeStart);

    // Interpolation opener: ${ or %{
    if (c === DOLLAR && this.text.charCodeAt(lexemeStart + 1) === LBRACE) {
      this.pos += 2;
      this.pushMode({ kind: "TEMPLATE_INTERP", braceDepth: 0 });
      // Skip optional strip marker immediately after ${
      // (Emitted as a separate TEMPLATE_STRIP by the next call.)
      return this.finishTemplateStructural(
        TokenKind.TEMPLATE_INTERP,
        leadingStart,
        lexemeStart,
      );
    }
    if (c === PERCENT && this.text.charCodeAt(lexemeStart + 1) === LBRACE) {
      this.pos += 2;
      this.pushMode({ kind: "TEMPLATE_CONTROL", braceDepth: 0 });
      return this.finishTemplateStructural(
        TokenKind.TEMPLATE_CONTROL,
        leadingStart,
        lexemeStart,
      );
    }

    // Close of a quoted string.
    if (c === QUOTE && mode.heredoc === undefined) {
      this.pos++;
      this.popMode();
      return this.finishTemplateStructural(
        TokenKind.CQUOTE,
        leadingStart,
        lexemeStart,
      );
    }

    // At the start of a heredoc line, try to match the closing delimiter.
    if (mode.heredoc && this.atStartOfHeredocLine(lexemeStart)) {
      const endLen = this.matchHeredocEnd(lexemeStart, mode.heredoc);
      if (endLen > 0) {
        this.pos = lexemeStart + endLen;
        this.popMode();
        return this.finishTemplateStructural(
          TokenKind.HEREDOC_END,
          leadingStart,
          lexemeStart,
        );
      }
    }

    // Otherwise this is literal content. Consume until the next structural
    // marker in the template.
    return this.scanQuotedLit(leadingStart, lexemeStart, mode);
  }

  private finishTemplateStructural(
    kind: TokenKind,
    leadingStart: number,
    lexemeStart: number,
  ): Token {
    const lexemeEnd = this.pos;
    // Structural template tokens may carry same-line trailing trivia ONLY
    // when we are now back in a NORMAL-like mode (CQUOTE / HEREDOC_END /
    // TEMPLATE_SEQ_END). If the next state is still TEMPLATE, trivia would
    // be template content and must not be consumed.
    const next = this.currentMode();
    if (next.kind !== "TEMPLATE") this.skipTrailingTrivia();
    const trailingEnd = this.pos;
    return this.make(kind, leadingStart, lexemeStart, lexemeEnd, trailingEnd);
  }

  private scanQuotedLit(
    leadingStart: number,
    lexemeStart: number,
    mode: ModeFrame,
  ): Token {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);

      if (mode.heredoc === undefined) {
        if (c === QUOTE) break;
        // Quoted strings technically disallow raw newlines per the HCL
        // spec, but the lexer absorbs them into the QUOTED_LIT so that we
        // always make forward progress. The parser is responsible for
        // flagging the semantic error.
      } else {
        if (c === LF || c === CR) {
          // Advance past the newline as part of the literal, then check
          // for a closing delimiter at the start of the next line.
          if (c === CR && this.text.charCodeAt(this.pos + 1) === LF) this.pos++;
          this.pos++;
          if (this.matchHeredocEnd(this.pos, mode.heredoc) > 0) break;
          continue;
        }
      }

      if (c === DOLLAR && this.text.charCodeAt(this.pos + 1) === LBRACE) break;
      if (c === DOLLAR && this.text.charCodeAt(this.pos + 1) === DOLLAR) {
        // Escaped $$ — consumed as literal, does not open an interpolation.
        this.pos += 2;
        continue;
      }
      if (c === PERCENT && this.text.charCodeAt(this.pos + 1) === LBRACE) break;
      if (c === PERCENT && this.text.charCodeAt(this.pos + 1) === PERCENT) {
        this.pos += 2;
        continue;
      }
      if (c === BACKSLASH && mode.heredoc === undefined) {
        // Consume escape sequence as literal (2 chars minimum).
        this.pos += 2;
        continue;
      }
      this.pos++;
    }
    const lexemeEnd = this.pos;
    // Never consume trailing trivia in TEMPLATE mode — adjacent whitespace
    // is literal content.
    return this.make(
      TokenKind.QUOTED_LIT,
      leadingStart,
      lexemeStart,
      lexemeEnd,
      lexemeEnd,
    );
  }

  /**
   * True iff `offset` is the first character of a line in the heredoc body
   * (either the very start of the body, or immediately after a newline).
   */
  private atStartOfHeredocLine(offset: number): boolean {
    if (offset === 0) return true;
    const prev = this.text.charCodeAt(offset - 1);
    return prev === LF || prev === CR;
  }

  /**
   * If the heredoc closing delimiter starts at `offset`, return the number
   * of characters it spans (including optional leading whitespace for `<<-`
   * heredocs and an optional trailing newline). Otherwise return 0.
   */
  private matchHeredocEnd(
    offset: number,
    heredoc: { delimiter: string; strip: boolean },
  ): number {
    let i = offset;
    if (heredoc.strip) {
      while (
        i < this.text.length &&
        (this.text.charCodeAt(i) === SPACE || this.text.charCodeAt(i) === TAB)
      ) {
        i++;
      }
    }
    const delim = heredoc.delimiter;
    if (this.text.slice(i, i + delim.length) !== delim) return 0;
    const after = i + delim.length;
    const afterChar = this.text.charCodeAt(after);
    // Delimiter must be followed by newline or EOF.
    if (
      after !== this.text.length &&
      afterChar !== LF &&
      afterChar !== CR
    ) {
      return 0;
    }
    return after - offset;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mode stack helpers
  // ─────────────────────────────────────────────────────────────────────────

  private pushMode(frame: ModeFrame): void {
    this.modes.push(frame);
  }

  private popMode(): void {
    if (this.modes.length > 1) this.modes.pop();
  }

  /** Advance `pos` past exactly one Unicode code point (handles surrogate pairs). */
  private advanceCodePoint(): void {
    const c = this.text.charCodeAt(this.pos);
    if (c >= 0xd800 && c <= 0xdbff && this.pos + 1 < this.text.length) {
      const next = this.text.charCodeAt(this.pos + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        this.pos += 2;
        return;
      }
    }
    this.pos++;
  }
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** Read one code point at `offset` and test ID_Start. */
function isIdStartCode(text: string, offset: number): boolean {
  const cp = text.codePointAt(offset);
  return cp !== undefined && isIdStart(cp);
}

/** Read one code point at `offset` and test ID_Continue. */
function isIdContinueCode(text: string, offset: number): boolean {
  const cp = text.codePointAt(offset);
  return cp !== undefined && isIdContinue(cp);
}
