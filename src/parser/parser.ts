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
 * Error recovery: on a statement-level parse error the parser records
 * an HCLParseError and resyncs to the next NEWLINE or closing brace at
 * the current depth. The tokens it skips stay in the body's `parts`, so
 * round-trip works even on inputs that contain errors, and a `}` with
 * no block to close is kept and stepped over, so recovery always moves
 * forward.
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
import { unescapeTemplateLiteral } from "../value.js";

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
    const body = this.startBody();
    this.parseBodyItems(body, terminator);
    return finishBody(body);
  }

  private startBody(): BodyBuilder {
    return {
      start: this.peek().range.start,
      parts: [],
      attributes: [],
      blocks: [],
      firstByName: new Map(),
    };
  }

  /** Parse statements into `body` until `terminator` or EOF. */
  private parseBodyItems(body: BodyBuilder, terminator: TokenKind | null): void {
    while (!this.atEnd()) {
      const tok = this.peek();
      if (terminator !== null && tok.kind === terminator) break;
      if (tok.kind === TokenKind.NEWLINE) {
        body.parts.push(this.consume());
        continue;
      }

      const errorsBefore = this.errors.length;
      const stmt = this.parseStatement();
      if (Array.isArray(stmt)) {
        // parseStatement reported an error and skipped to the end of the
        // line. Keep the skipped tokens so the CST stays lossless.
        body.parts.push(...stmt);
        if (stmt.length === 0) {
          // Nothing was skipped: the token is a `}` with no block to
          // close, where recovery stops. Keep it and step past it, or
          // this loop never ends.
          body.parts.push(this.consume());
        }
        continue;
      }
      this.addStatement(body, stmt);
      this.endStatement(body, stmt, terminator, errorsBefore);
      this.checkRedefined(body, stmt);
    }
  }

  private addStatement(body: BodyBuilder, stmt: AttributeNode | BlockNode): void {
    body.parts.push(stmt);
    if (stmt.kind === "Attribute") body.attributes.push(stmt);
    else body.blocks.push(stmt);
  }

  /**
   * Like Terraform (hclsyntax ParseBody), an argument may be set only
   * once per body. Every repeat is reported at its name and points back
   * to the first one.
   */
  private checkRedefined(body: BodyBuilder, stmt: AttributeNode | BlockNode): void {
    if (stmt.kind !== "Attribute") return;
    const first = body.firstByName.get(stmt.name);
    if (first === undefined) {
      body.firstByName.set(stmt.name, stmt);
      return;
    }
    const at = first.parts[0].range.start;
    this.errorAt(
      stmt.parts[0].range,
      `attribute redefined: the argument "${stmt.name}" was already set at ` +
        `line ${at.line}, column ${at.column}; each argument may be set only once`,
    );
  }

  /**
   * Like Terraform, an argument or block must end at a line break or at
   * the end of the file: `a = 1 b = 2` is an error. The body loop
   * consumes the line break itself. If the statement already reported an
   * error, the cursor can be anywhere on the line, so the rest of the
   * line is skipped without a second error.
   */
  private endStatement(
    body: BodyBuilder,
    stmt: AttributeNode | BlockNode,
    terminator: TokenKind | null,
    errorsBefore: number,
  ): void {
    const end = this.peek();
    if (end.kind === TokenKind.NEWLINE || end.kind === TokenKind.EOF) return;
    if (this.errors.length === errorsBefore) {
      let message = MISSING_NEWLINE_AFTER_ARGUMENT;
      if (stmt.kind === "Block") message = MISSING_NEWLINE_AFTER_BLOCK;
      else if (end.kind === TokenKind.COMMA) message = COMMA_AFTER_ARGUMENT;
      this.errorAt(end.range, message);
    }
    // A `}` that closes the enclosing block is left for that block. At
    // the top level there is no block to close, so it is skipped too.
    body.parts.push(...this.recoverToLineEnd(terminator === TokenKind.RBRACE));
  }

  /**
   * The body of a block whose first argument sits on the same line as
   * its `{`, like `b { a = 1 }`. As in Terraform, it holds exactly one
   * argument (no nested block) and must close on that line. If the line
   * ends before the `}`, the error is reported and the rest of the block
   * is read as an ordinary multi-line body.
   */
  private parseOneLineBody(): BodyNode {
    const body = this.startBody();
    const errorsBefore = this.errors.length;
    const head = this.peek();
    const next = this.peek(1);
    if (
      head.kind === TokenKind.IDENT &&
      (next.kind === TokenKind.IDENT ||
        next.kind === TokenKind.OQUOTE ||
        next.kind === TokenKind.LBRACE)
    ) {
      this.errorAt(
        { start: head.range.start, end: next.range.end },
        nestedBlockInOneLineBlock(head.lexeme),
      );
      body.parts.push(...this.recoverToLineEnd());
    } else {
      const stmt = this.parseStatement();
      if (Array.isArray(stmt)) {
        body.parts.push(...stmt);
      } else {
        this.addStatement(body, stmt);
        this.checkRedefined(body, stmt);
        const end = this.peek();
        if (end.kind !== TokenKind.RBRACE && end.kind !== TokenKind.EOF) {
          if (this.errors.length === errorsBefore) {
            this.errorAt(
              end.range,
              end.kind === TokenKind.COMMA
                ? ONE_LINE_BLOCK_COMMA
                : end.kind === TokenKind.NEWLINE
                  ? ONE_LINE_BLOCK_NEWLINE
                  : ONE_LINE_BLOCK_NOT_CLOSED,
            );
          }
          body.parts.push(...this.recoverToLineEnd());
        }
      }
    }
    if (this.peek().kind === TokenKind.NEWLINE) {
      this.parseBodyItems(body, TokenKind.RBRACE);
    }
    return finishBody(body);
  }

  /**
   * Parse one statement (Attribute or Block). When the statement cannot
   * be parsed, reports an error, skips to the end of the line and returns
   * the skipped tokens (possibly none) for the caller to keep in the CST.
   */
  private parseStatement(): AttributeNode | BlockNode | Token[] {
    const head = this.peek();
    if (head.kind !== TokenKind.IDENT) {
      this.errorAt(head.range, `expected an attribute or block, got ${head.kind}`);
      return this.recoverToLineEnd();
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
    return this.recoverToLineEnd();
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
    const first = this.peek().kind;
    const body =
      first === TokenKind.NEWLINE ||
      first === TokenKind.EOF ||
      first === TokenKind.RBRACE
        ? this.parseBody(TokenKind.RBRACE)
        : this.parseOneLineBody();
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
          if (
            inner.kind === TokenKind.QUOTED_LIT ||
            inner.kind === TokenKind.INVALID
          ) {
            // INVALID here is a bad backslash escape or a raw line break:
            // report it and keep its text so the CST stays complete.
            literalParts.push(inner.lexeme);
            parts.push(this.consume());
            if (inner.kind === TokenKind.INVALID) {
              this.errorAt(inner.range, inner.error ?? "invalid label text");
            }
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
        // Store the label as Terraform reads it, with escapes applied.
        // The tokens in `parts` keep the source text for printing.
        labels.push({
          value: unescapeTemplateLiteral(literalParts.join(""), false),
          quoted: true,
        });
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
   * resync point. With `stopAtRBrace` false, a `}` at depth 0 is skipped
   * like any other token. Returns the skipped tokens so the caller can
   * keep them in the CST.
   */
  private recoverToLineEnd(stopAtRBrace = true): Token[] {
    const skipped: Token[] = [];
    let depth = 0;
    while (!this.atEnd()) {
      const tok = this.peek();
      if (depth === 0) {
        if (
          tok.kind === TokenKind.NEWLINE ||
          (tok.kind === TokenKind.RBRACE && stopAtRBrace) ||
          tok.kind === TokenKind.EOF
        ) {
          break;
        }
      }
      if (OPENERS.has(tok.kind)) depth++;
      else if (CLOSERS.has(tok.kind) && depth > 0) depth--;
      skipped.push(this.consume());
    }
    return skipped;
  }
}

/** A body being parsed: its statements so far, in source order. */
interface BodyBuilder {
  readonly start: Position;
  readonly parts: (AttributeNode | BlockNode | Token)[];
  readonly attributes: AttributeNode[];
  readonly blocks: BlockNode[];
  /** The first argument set under each name, for "attribute redefined". */
  readonly firstByName: Map<string, AttributeNode>;
}

function finishBody(body: BodyBuilder): BodyNode {
  const { start, parts, attributes, blocks } = body;
  const end = parts.length > 0 ? endOfPart(parts[parts.length - 1]!) : start;
  return { kind: "Body", range: { start, end }, parts, attributes, blocks };
}

/**
 * Endpoint of a CST/Token part, for range computation. Tokens expose their
 * range.end directly; CST nodes expose their node range.
 */
function endOfPart(part: AttributeNode | BlockNode | Token): Position {
  return "lexeme" in part ? part.range.end : part.range.end;
}

// Statement-ending errors. Each starts with Terraform's summary for the
// same error (hashicorp/hcl, hclsyntax/parser.go), in lower case.
const MISSING_NEWLINE_AFTER_ARGUMENT =
  "missing newline after argument: an argument definition must end with a newline";
const MISSING_NEWLINE_AFTER_BLOCK =
  "missing newline after block definition: a block definition must end with a newline";
const COMMA_AFTER_ARGUMENT =
  "unexpected comma after argument: argument definitions must be separated " +
  "by newlines, not commas";
const ONE_LINE_BLOCK_COMMA =
  "invalid single-argument block definition: a single-line block can hold " +
  "only one argument; to set more, put each argument on its own line";
const ONE_LINE_BLOCK_NEWLINE =
  "invalid single-argument block definition: an argument on the same line " +
  "as the block's '{' makes a single-line block, which must also close on " +
  "that line; put the '}' right after the argument";
const ONE_LINE_BLOCK_NOT_CLOSED =
  "invalid single-argument block definition: a single-line block must end " +
  "with '}' right after its one argument";

function nestedBlockInOneLineBlock(name: string): string {
  return (
    "argument definition required: a single-line block can hold only one " +
    `argument; to set argument "${name}", use "="; to define a nested ` +
    "block, put it on its own line inside the parent block"
  );
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
