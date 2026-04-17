/**
 * M3 structural parser. Consumes a Token array from the lexer and
 * produces a BodyNode CST whose `parts` tree contains every lexer token
 * in source order — the invariant that makes lossless round-trip via
 * `print(body) === source.text` hold for well-formed input.
 *
 * M3 scope: ConfigFile / Body / Block / Attribute / BlockLabels. The
 * value of each attribute is captured as an opaque ExpressionNode
 * holding a flat token run; M4 replaces the internal shape with a real
 * expression AST without changing the outer surface.
 *
 * Error recovery: on any parse error the parser records an
 * HCLParseError and resyncs to the next NEWLINE or closing brace at the
 * current depth. The erroneous tokens are wrapped in an ErrorNode so
 * the CST is always complete — round-trip works even on inputs that
 * contain errors.
 */

import { HCLParseError } from "../errors.js";
import type { Position, Range } from "../source.js";
import { SourceFile } from "../source.js";
import { lex } from "../lexer/lexer.js";
import type { Token } from "../lexer/token.js";
import { TokenKind } from "../lexer/token.js";
import type {
  AttributeNode,
  BlockLabelsNode,
  BlockNode,
  BodyNode,
  ExprNode,
  LabelInfo,
  Node,
} from "./nodes.js";
import { parseExpression as parseExpressionNode } from "./expr.js";

export interface ParserOptions {
  /** Throw on the first error (true) or collect all errors (false). Default: true. */
  bail?: boolean;
}

export interface ParseResult {
  readonly body: BodyNode;
  readonly errors: readonly HCLParseError[];
}

/**
 * Parse an HCL source file into a BodyNode plus any errors encountered.
 * When `bail: true` (the default) the first error throws; otherwise
 * every error is collected and parsing continues via recovery.
 */
export function parse(source: SourceFile, options: ParserOptions = {}): ParseResult {
  return new Parser(source, options).parse();
}

/**
 * Parse a single standalone expression. Intended for tools and tests
 * that want to operate on an expression string without the surrounding
 * attribute syntax (e.g., the M4 property test
 * `lex(text) === lex(print(parseExpr(text)))`).
 */
export interface ExprParseResult {
  readonly expr: ExprNode;
  readonly errors: readonly HCLParseError[];
}

export function parseExpr(
  text: string,
  options: ParserOptions = {},
): ExprParseResult {
  const source = new SourceFile(text);
  const parser = new Parser(source, options);
  const expr = parser.parseOneExpression();
  return { expr, errors: parser.getErrors() };
}

const OPENERS = new Set<TokenKind>([
  TokenKind.LBRACE,
  TokenKind.LBRACK,
  TokenKind.LPAREN,
  TokenKind.OQUOTE,
  TokenKind.HEREDOC_BEGIN,
  TokenKind.TEMPLATE_INTERP,
  TokenKind.TEMPLATE_CONTROL,
]);

const CLOSERS = new Set<TokenKind>([
  TokenKind.RBRACE,
  TokenKind.RBRACK,
  TokenKind.RPAREN,
  TokenKind.CQUOTE,
  TokenKind.HEREDOC_END,
  TokenKind.TEMPLATE_SEQ_END,
]);

export class Parser {
  readonly source: SourceFile;
  private readonly tokens: readonly Token[];
  private readonly bail: boolean;
  private readonly errors: HCLParseError[] = [];
  private pos = 0;

  constructor(source: SourceFile, options: ParserOptions = {}) {
    this.source = source;
    this.tokens = lex(source);
    this.bail = options.bail ?? true;
  }

  parse(): ParseResult {
    const body = this.parseBody(/* terminator */ null);
    // Consume the EOF marker as part of the body so every lexer token is
    // captured in the CST (round-trip invariant).
    const eof = this.peek();
    if (eof.kind === TokenKind.EOF) {
      (body.parts as (AttributeNode | BlockNode | Token)[]).push(eof);
      this.pos++;
    }
    return { body, errors: this.errors };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Grammar productions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parse a Body up to `terminator` (null = EOF, or TokenKind.RBRACE for
   * a block body). Consumes separators between statements but NOT the
   * terminator itself — the caller handles that.
   */
  private parseBody(terminator: TokenKind | null): BodyNode {
    const parts: (AttributeNode | BlockNode | Token)[] = [];
    const attributes: AttributeNode[] = [];
    const blocks: BlockNode[] = [];
    const startPos: Position = this.peek().range.start;

    while (!this.atEnd()) {
      const tok = this.peek();
      if (tok.kind === TokenKind.EOF) break;
      if (terminator !== null && tok.kind === terminator) break;
      if (tok.kind === TokenKind.NEWLINE) {
        parts.push(this.consume());
        continue;
      }

      const stmt = this.parseStatement();
      if (stmt) {
        parts.push(stmt);
        if (stmt.kind === "Attribute") attributes.push(stmt);
        else blocks.push(stmt);
      } else {
        // parseStatement already emitted an error and recovered to the
        // next NEWLINE / terminator. Continue the loop.
      }
    }

    const endPos: Position =
      parts.length > 0
        ? endOfPart(parts[parts.length - 1]!)
        : startPos;

    return {
      kind: "Body",
      range: { start: startPos, end: endPos },
      parts,
      attributes,
      blocks,
    };
  }

  /**
   * Parse one statement (Attribute or Block). Returns null if the
   * statement could not be parsed; in that case `this.errors` has been
   * appended to and the token cursor has been advanced past the bad
   * region.
   */
  private parseStatement(): AttributeNode | BlockNode | null {
    const head = this.peek();
    if (head.kind !== TokenKind.IDENT) {
      this.errorAt(head.range, `expected an attribute or block, got ${head.kind}`);
      this.recoverToLineEnd();
      return null;
    }

    // Look at the token following the IDENT to disambiguate.
    const next = this.peek(1);
    if (next.kind === TokenKind.ASSIGN) {
      return this.parseAttribute();
    }
    if (
      next.kind === TokenKind.IDENT ||
      next.kind === TokenKind.OQUOTE ||
      next.kind === TokenKind.LBRACE
    ) {
      return this.parseBlock();
    }
    this.errorAt(
      next.range,
      `expected '=' or a block header after identifier, got ${next.kind}`,
    );
    this.recoverToLineEnd();
    return null;
  }

  private parseAttribute(): AttributeNode {
    const nameTok = this.consume(); // IDENT
    const assignTok = this.consume(); // ASSIGN
    const expression = this.parseExpression();
    return {
      kind: "Attribute",
      range: {
        start: nameTok.range.start,
        end: expression.range.end,
      },
      parts: [nameTok, assignTok, expression],
      name: nameTok.lexeme,
      expression,
    };
  }

  /**
   * Public entry point for the expression parser (exposed so the
   * standalone `parseExpr(text)` helper can drive the same cursor).
   */
  parseOneExpression(): ExprNode {
    return this.parseExpression();
  }

  /** Accessor for the collected errors list (used by parseExpr). */
  getErrors(): readonly HCLParseError[] {
    return this.errors;
  }

  private parseBlock(): BlockNode {
    const typeTok = this.consume(); // IDENT
    const labels = this.parseBlockLabels();

    const lbrace = this.expect(TokenKind.LBRACE);
    const body = this.parseBody(TokenKind.RBRACE);
    const rbrace = this.expect(TokenKind.RBRACE);

    const parts: (Token | BlockLabelsNode | BodyNode)[] = [typeTok];
    if (labels) parts.push(labels);
    parts.push(lbrace, body, rbrace);

    return {
      kind: "Block",
      range: {
        start: typeTok.range.start,
        end: rbrace.range.end,
      },
      parts,
      type: typeTok.lexeme,
      labels,
      body,
    };
  }

  private parseBlockLabels(): BlockLabelsNode | null {
    const parts: Token[] = [];
    const labels: LabelInfo[] = [];
    while (!this.atEnd()) {
      const tok = this.peek();
      if (tok.kind === TokenKind.LBRACE || tok.kind === TokenKind.NEWLINE) break;
      if (tok.kind === TokenKind.IDENT) {
        parts.push(this.consume());
        labels.push({ value: tok.lexeme, quoted: false });
        continue;
      }
      if (tok.kind === TokenKind.OQUOTE) {
        const open = this.consume();
        parts.push(open);
        const literalParts: string[] = [];
        let hadInterp = false;
        while (!this.atEnd()) {
          const inner = this.peek();
          if (inner.kind === TokenKind.CQUOTE) {
            parts.push(this.consume());
            break;
          }
          if (inner.kind === TokenKind.QUOTED_LIT) {
            literalParts.push(inner.lexeme);
            parts.push(this.consume());
            continue;
          }
          if (
            inner.kind === TokenKind.TEMPLATE_INTERP ||
            inner.kind === TokenKind.TEMPLATE_CONTROL
          ) {
            if (!hadInterp) {
              this.errorAt(
                inner.range,
                "block label strings must not contain interpolations",
              );
              hadInterp = true;
            }
            // Consume through the matching TEMPLATE_SEQ_END to resync.
            parts.push(this.consume());
            let depth = 1;
            while (!this.atEnd() && depth > 0) {
              const t = this.peek();
              if (OPENERS.has(t.kind)) depth++;
              else if (CLOSERS.has(t.kind)) depth--;
              parts.push(this.consume());
            }
            continue;
          }
          // Unexpected token inside a label string — bail out of the label.
          this.errorAt(inner.range, `unexpected ${inner.kind} inside block label`);
          break;
        }
        labels.push({ value: literalParts.join(""), quoted: true });
        continue;
      }
      // Anything else in the label position is a structural error.
      this.errorAt(
        tok.range,
        `expected block label or '{', got ${tok.kind}`,
      );
      break;
    }
    if (parts.length === 0) return null;
    return {
      kind: "BlockLabels",
      range: {
        start: parts[0]!.range.start,
        end: parts[parts.length - 1]!.range.end,
      },
      parts,
      labels,
    };
  }

  /** Dispatch to the full expression parser in expr.ts. */
  private parseExpression(): ExprNode {
    return parseExpressionNode(this);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Token cursor helpers (public — consumed by the expression parser via
  // the ExprCursor interface in expr.ts).
  // ─────────────────────────────────────────────────────────────────────────

  peek(offset = 0): Token {
    const idx = this.pos + offset;
    if (idx >= this.tokens.length) {
      return this.tokens[this.tokens.length - 1]!; // always EOF
    }
    return this.tokens[idx]!;
  }

  consume(): Token {
    const tok = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return tok;
  }

  atEnd(): boolean {
    return this.peek().kind === TokenKind.EOF;
  }

  /**
   * Consume a token of the expected kind, or emit an error and return a
   * synthesized placeholder token so the CST remains complete. The
   * placeholder has empty trivia and lexeme so it does not perturb the
   * round-trip invariant for well-formed input; for inputs missing a
   * token (e.g. unclosed block) the placeholder preserves structural
   * position at the cost of round-trip fidelity on error.
   */
  private expect(kind: TokenKind): Token {
    const tok = this.peek();
    if (tok.kind === kind) {
      return this.consume();
    }
    this.errorAt(tok.range, `expected ${kind}, got ${tok.kind}`);
    return syntheticToken(kind, tok.range.start);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Error handling
  // ─────────────────────────────────────────────────────────────────────────

  errorAt(range: Range, message: string): void {
    const err = new HCLParseError(this.source, range, message);
    this.errors.push(err);
    if (this.bail) throw err;
  }

  /**
   * Resync to the next top-level statement boundary after an error. We
   * skip tokens up to (but not including) the next NEWLINE, RBRACE, or
   * EOF at depth 0, while also respecting paren / bracket / brace
   * nesting so that we don't treat a RBRACE inside a struct literal as a
   * resync point.
   */
  private recoverToLineEnd(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const tok = this.peek();
      if (depth === 0) {
        if (
          tok.kind === TokenKind.NEWLINE ||
          tok.kind === TokenKind.RBRACE ||
          tok.kind === TokenKind.EOF
        ) {
          return;
        }
      }
      if (OPENERS.has(tok.kind)) depth++;
      else if (CLOSERS.has(tok.kind) && depth > 0) depth--;
      this.consume();
    }
  }
}

/**
 * Endpoint of a CST/Token part, for range computation. Tokens expose their
 * range.end directly; CST nodes expose their node range.
 */
function endOfPart(part: AttributeNode | BlockNode | Token): Position {
  return "lexeme" in part ? part.range.end : part.range.end;
}

/**
 * Build a zero-width synthetic Token at `position`, used by `expect()`
 * when the parser needs to preserve structural position after a missing
 * token. These synthetic tokens never appear in well-formed round-trip.
 */
function syntheticToken(kind: TokenKind, position: Position): Token {
  return {
    kind,
    lexeme: "",
    leadingTrivia: "",
    trailingTrivia: "",
    range: { start: position, end: position },
  };
}

/** Public helper: re-export `print` for ergonomics. */
export { print } from "./print.js";
/** Public helper: re-export node guards for consumers. */
export { isToken } from "./nodes.js";
export type { Node };
