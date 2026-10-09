/**
 * HCL2 expression parser (Pratt/recursive-descent).
 *
 * Consumes the shared token cursor from parser.ts and produces a
 * structured ExprNode tree. Every node carries its source range and a
 * `parts` array mixing Tokens with child nodes in source order — walking
 * `parts` recursively and emitting trivia + lexeme for each Token
 * reproduces the input byte-for-byte.
 *
 * Precedence (lowest → highest, per docs/design.md §6.2):
 *
 *   conditional (?:) → || → && → == != → < <= > >= → + - → * / % → unary (- !) → postfix → primary
 *
 * All binary operators are left-associative; unary and conditional are
 * right-associative. `?:` is parsed as a single level; chaining
 * `a ? b : c ? d : e` yields `a ? b : (c ? d : e)`.
 */

import { HCLParseError } from "../errors.js";
import type { Range, SourceFile } from "../source.js";
import type { Token } from "../lexer/token.js";
import { TokenKind } from "../lexer/token.js";
import type {
  BinaryOp,
  BinaryOpNode,
  ConditionalNode,
  ErrorExprNode,
  ExprNode,
  ForNode,
  FunctionCallNode,
  GetAttrStep,
  IndexStep,
  LiteralNode,
  ObjectItemNode,
  ObjectNode,
  ParensNode,
  SplatItemNode,
  SplatNode,
  TemplateForDirectivePart,
  TemplateIfDirectivePart,
  TemplateInterpolationPart,
  TemplateNode,
  TemplatePart,
  TemplateStringPart,
  TraversalNode,
  TraversalStep,
  TupleNode,
  UnaryOp,
  UnaryOpNode,
  VariableNode,
} from "./nodes.js";
import { isToken } from "./nodes.js";

/**
 * Cursor + error-sink interface the expression parser needs. The outer
 * Parser implements this.
 */
export interface ExprCursor {
  readonly source: SourceFile;
  peek(offset?: number): Token;
  consume(): Token;
  atEnd(): boolean;
  errorAt(range: Range, message: string): void;
  /**
   * Report an error at `tok`. A token the lexer could not read (INVALID)
   * reports its own message instead, such as "invalid character", and
   * only once however many rules trip over it.
   */
  errorAtToken(tok: Token, message: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level dispatch
// ─────────────────────────────────────────────────────────────────────────────

/** Parse one expression. */
export function parseExpression(ctx: ExprCursor): ExprNode {
  return parseConditional(ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Precedence levels
// ─────────────────────────────────────────────────────────────────────────────

function parseConditional(ctx: ExprCursor): ExprNode {
  const cond = parseBinaryOr(ctx);
  if (ctx.peek().kind !== TokenKind.QUESTION) return cond;
  const questionToken = ctx.consume();
  const then = parseExpression(ctx);
  if (ctx.peek().kind !== TokenKind.COLON) {
    ctx.errorAtToken(ctx.peek(), "expected ':' in conditional expression");
    const node: ConditionalNode = {
      kind: "Conditional",
      range: { start: cond.range.start, end: then.range.end },
      parts: [cond, questionToken, then, syntheticToken(TokenKind.COLON, then.range.end), errorExpr(ctx, "missing else branch")] as ConditionalNode["parts"],
      cond,
      questionToken,
      then,
      colonToken: syntheticToken(TokenKind.COLON, then.range.end),
      else_: errorExpr(ctx, "missing else branch"),
    };
    return node;
  }
  const colonToken = ctx.consume();
  const else_ = parseExpression(ctx);
  const node: ConditionalNode = {
    kind: "Conditional",
    range: { start: cond.range.start, end: else_.range.end },
    parts: [cond, questionToken, then, colonToken, else_],
    cond,
    questionToken,
    then,
    colonToken,
    else_,
  };
  return node;
}

function parseBinaryLevel(
  ctx: ExprCursor,
  next: (ctx: ExprCursor) => ExprNode,
  ops: ReadonlySet<TokenKind>,
): ExprNode {
  let left = next(ctx);
  while (ops.has(ctx.peek().kind)) {
    const opToken = ctx.consume();
    const right = next(ctx);
    left = buildBinary(left, opToken, right);
  }
  return left;
}

const OR_OPS = new Set<TokenKind>([TokenKind.OR]);
const AND_OPS = new Set<TokenKind>([TokenKind.AND]);
const EQ_OPS = new Set<TokenKind>([TokenKind.EQ, TokenKind.NEQ]);
const CMP_OPS = new Set<TokenKind>([
  TokenKind.LT,
  TokenKind.LE,
  TokenKind.GT,
  TokenKind.GE,
]);
const ADD_OPS = new Set<TokenKind>([TokenKind.PLUS, TokenKind.MINUS]);
const MUL_OPS = new Set<TokenKind>([
  TokenKind.STAR,
  TokenKind.SLASH,
  TokenKind.PERCENT,
]);

function parseBinaryOr(ctx: ExprCursor): ExprNode {
  return parseBinaryLevel(ctx, parseBinaryAnd, OR_OPS);
}
function parseBinaryAnd(ctx: ExprCursor): ExprNode {
  return parseBinaryLevel(ctx, parseEquality, AND_OPS);
}
function parseEquality(ctx: ExprCursor): ExprNode {
  return parseBinaryLevel(ctx, parseComparison, EQ_OPS);
}
function parseComparison(ctx: ExprCursor): ExprNode {
  return parseBinaryLevel(ctx, parseAdditive, CMP_OPS);
}
function parseAdditive(ctx: ExprCursor): ExprNode {
  return parseBinaryLevel(ctx, parseMultiplicative, ADD_OPS);
}
function parseMultiplicative(ctx: ExprCursor): ExprNode {
  return parseBinaryLevel(ctx, parseUnary, MUL_OPS);
}

function parseUnary(ctx: ExprCursor): ExprNode {
  const tok = ctx.peek();
  if (tok.kind === TokenKind.MINUS || tok.kind === TokenKind.BANG) {
    const opToken = ctx.consume();
    const operand = parseUnary(ctx);
    const op: UnaryOp = opToken.kind === TokenKind.MINUS ? "-" : "!";
    const node: UnaryOpNode = {
      kind: "UnaryOp",
      range: { start: opToken.range.start, end: operand.range.end },
      parts: [opToken, operand],
      op,
      opToken,
      operand,
    };
    return node;
  }
  return parsePostfix(ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Postfix: traversal, index, splat, call
// ─────────────────────────────────────────────────────────────────────────────

function parsePostfix(ctx: ExprCursor): ExprNode {
  return parseTraversals(ctx, parsePrimary(ctx));
}

/** Apply every `.` and `[` step that follows to `expr`. */
function parseTraversals(ctx: ExprCursor, expr: ExprNode): ExprNode {
  for (;;) {
    const tok = ctx.peek();
    if (tok.kind === TokenKind.DOT) {
      expr = parseAfterDot(ctx, expr);
      continue;
    }
    if (tok.kind === TokenKind.LBRACK) {
      expr = parseAfterLBrack(ctx, expr);
      continue;
    }
    break;
  }
  return expr;
}

function parseAfterDot(ctx: ExprCursor, source: ExprNode): ExprNode {
  const dotToken = ctx.consume(); // DOT
  if (ctx.peek().kind === TokenKind.STAR) {
    return parseAttrSplat(ctx, source, dotToken, ctx.consume());
  }
  return appendTraversalStep(source, parseNameAfterDot(ctx, dotToken));
}

/**
 * The step after a `.`: an identifier, or a number for the legacy index
 * form `a.0` (kept as a GetAttr whose name is the number; an evaluator
 * reads it as an index). Anything else is Terraform's "invalid attribute
 * name": the step gets an empty synthetic name, and the token is left
 * for the caller, so it is never taken as a name (or, at the end of the
 * file, put in the tree twice).
 */
function parseNameAfterDot(ctx: ExprCursor, dotToken: Token): GetAttrStep {
  const next = ctx.peek();
  if (next.kind === TokenKind.IDENT || next.kind === TokenKind.NUMBER) {
    const nameToken = ctx.consume();
    return {
      kind: "GetAttr",
      range: { start: dotToken.range.start, end: nameToken.range.end },
      dotToken,
      nameToken,
      name: nameToken.lexeme,
    };
  }
  ctx.errorAtToken(next, INVALID_ATTRIBUTE_NAME);
  const synth = syntheticToken(TokenKind.IDENT, dotToken.range.end);
  return {
    kind: "GetAttr",
    range: { start: dotToken.range.start, end: synth.range.end },
    dotToken,
    nameToken: synth,
    name: "",
  };
}

function parseIndexStep(ctx: ExprCursor): IndexStep {
  const lbrackToken = ctx.consume(); // LBRACK
  const key = parseExpression(ctx);
  const rbrackToken = expectOrSynth(ctx, TokenKind.RBRACK, "expected ']'");
  return {
    kind: "Index",
    range: { start: lbrackToken.range.start, end: rbrackToken.range.end },
    lbrackToken,
    key,
    rbrackToken,
  };
}

/** True when the next three tokens are `[ * ]`. */
function atFullSplat(ctx: ExprCursor): boolean {
  return (
    ctx.peek().kind === TokenKind.LBRACK &&
    ctx.peek(1).kind === TokenKind.STAR &&
    ctx.peek(2).kind === TokenKind.RBRACK
  );
}

function parseAfterLBrack(ctx: ExprCursor, source: ExprNode): ExprNode {
  if (atFullSplat(ctx)) return parseFullSplat(ctx, source);
  // Regular index.
  return appendTraversalStep(source, parseIndexStep(ctx));
}

/**
 * An attribute-only splat, `source.*.a.b`. As in the HCL spec
 * (`attrSplat = "." "*" GetAttr*`) its steps are attribute names only:
 * an index after it applies to the splat's result, so the steps stop at
 * `[` and parsePostfix carries on from there. Another `.*` inside it is
 * Terraform's "nested splat expression not allowed".
 */
function parseAttrSplat(
  ctx: ExprCursor,
  source: ExprNode,
  dotToken: Token,
  starToken: Token,
): SplatNode {
  const each: TraversalStep[] = [];
  const parts: Array<Token | ExprNode> = [source, dotToken, starToken];
  while (ctx.peek().kind === TokenKind.DOT) {
    if (ctx.peek(1).kind === TokenKind.STAR) {
      // Leave the `.*` for parsePostfix, which reads it as a new splat.
      ctx.errorAtToken(ctx.peek(1), NESTED_SPLAT);
      break;
    }
    const step = parseNameAfterDot(ctx, ctx.consume());
    each.push(step);
    parts.push(step.dotToken, step.nameToken);
    if (step.name === "") break;
  }
  return makeSplat(source, parts, each, "attr", starToken);
}

/**
 * A full splat, `source[*].a[0].b`. As in hashicorp/hcl, it runs every
 * later step on each element, later splats included. The attribute and
 * index steps right after `[*]` go in `each`. If another splat (`.*` or
 * `[*]`) follows, the rest of the chain, from that splat on, is parsed
 * on a SplatItem that stands for each element and goes in `inner`.
 */
function parseFullSplat(ctx: ExprCursor, source: ExprNode): SplatNode {
  const lbrackToken = ctx.consume();
  const starToken = ctx.consume();
  const rbrackToken = ctx.consume();
  const each: TraversalStep[] = [];
  const parts: Array<Token | ExprNode> = [source, lbrackToken, starToken, rbrackToken];
  for (;;) {
    const t = ctx.peek();
    if (t.kind === TokenKind.DOT && ctx.peek(1).kind !== TokenKind.STAR) {
      const step = parseNameAfterDot(ctx, ctx.consume());
      each.push(step);
      parts.push(step.dotToken, step.nameToken);
      if (step.name === "") break;
      continue;
    }
    if (t.kind === TokenKind.LBRACK && !atFullSplat(ctx)) {
      const step = parseIndexStep(ctx);
      each.push(step);
      parts.push(step.lbrackToken, step.key, step.rbrackToken);
      continue;
    }
    break;
  }
  const last = each.length > 0 ? each[each.length - 1]!.range.end : rbrackToken.range.end;
  let inner: ExprNode | null = null;
  const next = ctx.peek();
  if (
    (next.kind === TokenKind.DOT && ctx.peek(1).kind === TokenKind.STAR) ||
    atFullSplat(ctx)
  ) {
    const item: SplatItemNode = {
      kind: "SplatItem",
      range: { start: last, end: last },
      parts: [],
    };
    inner = parseTraversals(ctx, item);
    parts.push(inner);
  }
  return makeSplat(source, parts, each, "full", rbrackToken, inner);
}

function makeSplat(
  source: ExprNode,
  parts: Array<Token | ExprNode>,
  each: TraversalStep[],
  style: SplatNode["style"],
  marker: Token,
  inner: ExprNode | null = null,
): SplatNode {
  const last = each.length > 0 ? each[each.length - 1]! : null;
  const end = inner ? inner.range.end : last ? last.range.end : marker.range.end;
  return {
    kind: "Splat",
    range: { start: source.range.start, end },
    parts,
    source,
    style,
    each,
    inner,
  };
}

function appendTraversalStep(source: ExprNode, step: TraversalStep): TraversalNode {
  // If source is already a Traversal, append. Otherwise wrap.
  if (source.kind === "Traversal") {
    const parts = [...source.parts];
    if (step.kind === "GetAttr") parts.push(step.dotToken, step.nameToken);
    else parts.push(step.lbrackToken, step.key, step.rbrackToken);
    const node: TraversalNode = {
      kind: "Traversal",
      range: { start: source.range.start, end: step.range.end },
      parts,
      source: source.source,
      steps: [...source.steps, step],
    };
    return node;
  }
  const parts: Array<Token | ExprNode> = [source];
  if (step.kind === "GetAttr") parts.push(step.dotToken, step.nameToken);
  else parts.push(step.lbrackToken, step.key, step.rbrackToken);
  const node: TraversalNode = {
    kind: "Traversal",
    range: { start: source.range.start, end: step.range.end },
    parts,
    source,
    steps: [step],
  };
  return node;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primary expressions
// ─────────────────────────────────────────────────────────────────────────────

function parsePrimary(ctx: ExprCursor): ExprNode {
  const tok = ctx.peek();
  switch (tok.kind) {
    case TokenKind.NUMBER: {
      const t = ctx.consume();
      const node: LiteralNode = {
        kind: "Literal",
        range: t.range,
        parts: [t],
        valueType: "number",
        value: Number(t.lexeme),
      };
      return node;
    }
    case TokenKind.IDENT: {
      // Function call? An identifier followed by `(`, or by `::` for a
      // provider-defined function, starts a call. This comes before the
      // keyword checks: HCL reads `true(1)` as a call too.
      const after = ctx.peek(1).kind;
      if (after === TokenKind.LPAREN || after === TokenKind.DOUBLE_COLON) {
        return parseCall(ctx);
      }
      const name = tok.lexeme;
      if (name === "true" || name === "false") {
        const t = ctx.consume();
        const node: LiteralNode = {
          kind: "Literal",
          range: t.range,
          parts: [t],
          valueType: "boolean",
          value: name === "true",
        };
        return node;
      }
      if (name === "null") {
        const t = ctx.consume();
        const node: LiteralNode = {
          kind: "Literal",
          range: t.range,
          parts: [t],
          valueType: "null",
          value: null,
        };
        return node;
      }
      const t = ctx.consume();
      const node: VariableNode = {
        kind: "Variable",
        range: t.range,
        parts: [t],
        name: t.lexeme,
      };
      return node;
    }
    case TokenKind.OQUOTE:
      return parseQuotedTemplate(ctx);
    case TokenKind.HEREDOC_BEGIN:
      return parseHeredocTemplate(ctx);
    case TokenKind.LBRACK:
      return parseTupleOrFor(ctx);
    case TokenKind.LBRACE:
      return parseObjectOrFor(ctx);
    case TokenKind.LPAREN:
      return parseParens(ctx);
    default:
      ctx.errorAtToken(tok, `expected expression, got ${tok.kind}`);
      return errorExpr(ctx, `expected expression, got ${tok.kind}`);
  }
}

/**
 * Parse a call: `name(args)`, or a provider-defined function call whose
 * name has several segments joined by `::` (`provider::aws::arn_parse(x)`,
 * spaces allowed around `::`). `name` joins the segments with `::` and no
 * spaces, the way HCL names the function; `nameToken` is the first
 * segment. A `::` with no name after it, or a name with no `(` after it,
 * is an error (Terraform's "Missing function name" and "Missing open
 * parenthesis"); the tokens read so far stay in an ErrorExpr node so the
 * CST stays lossless.
 */
function parseCall(ctx: ExprCursor): FunctionCallNode | ErrorExprNode {
  const nameToken = ctx.consume(); // IDENT
  const nameParts: Token[] = [nameToken];
  let name = nameToken.lexeme;
  while (ctx.peek().kind === TokenKind.DOUBLE_COLON) {
    nameParts.push(ctx.consume());
    const segment = ctx.peek();
    if (segment.kind !== TokenKind.IDENT) {
      return callNameError(
        ctx,
        nameParts,
        segment,
        "missing function name: '::' must be followed by a function name",
      );
    }
    nameParts.push(ctx.consume());
    name += "::" + segment.lexeme;
  }
  if (ctx.peek().kind !== TokenKind.LPAREN) {
    return callNameError(
      ctx,
      nameParts,
      ctx.peek(),
      "missing open parenthesis: a function name must be followed by '(' to start the call",
    );
  }
  const lparen = ctx.consume(); // LPAREN
  const args: ExprNode[] = [];
  const parts: Array<Token | ExprNode> = [...nameParts, lparen];
  let expandFinal = false;
  if (ctx.peek().kind !== TokenKind.RPAREN) {
    for (;;) {
      const arg = parseExpression(ctx);
      args.push(arg);
      parts.push(arg);
      const after = ctx.peek();
      if (after.kind === TokenKind.ELLIPSIS) {
        expandFinal = true;
        parts.push(ctx.consume());
        break;
      }
      if (after.kind === TokenKind.COMMA) {
        parts.push(ctx.consume());
        // Allow trailing comma.
        if (ctx.peek().kind === TokenKind.RPAREN) break;
        continue;
      }
      break;
    }
  }
  const rparen = expectOrSynth(ctx, TokenKind.RPAREN, "expected ')' in call");
  parts.push(rparen);
  const node: FunctionCallNode = {
    kind: "Call",
    range: { start: nameToken.range.start, end: rparen.range.end },
    parts,
    name,
    nameToken,
    args,
    expandFinal,
  };
  return node;
}

/** Report a malformed call name at `at`, keeping the name tokens read so far. */
function callNameError(
  ctx: ExprCursor,
  nameParts: Token[],
  at: Token,
  message: string,
): ErrorExprNode {
  ctx.errorAtToken(at, message);
  return {
    kind: "ErrorExpr",
    range: {
      start: nameParts[0]!.range.start,
      end: nameParts[nameParts.length - 1]!.range.end,
    },
    parts: nameParts,
    message,
  };
}

function parseParens(ctx: ExprCursor): ParensNode {
  const lparen = ctx.consume(); // LPAREN
  const inner = parseExpression(ctx);
  const rparen = expectOrSynth(ctx, TokenKind.RPAREN, "expected ')'");
  return {
    kind: "Parens",
    range: { start: lparen.range.start, end: rparen.range.end },
    parts: [lparen, inner, rparen],
    inner,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection constructors + for-expressions
// ─────────────────────────────────────────────────────────────────────────────

function parseTupleOrFor(ctx: ExprCursor): TupleNode | ForNode {
  const lbrack = ctx.consume(); // LBRACK
  if (isForKeyword(ctx.peek())) {
    return parseForExpression(ctx, lbrack, false);
  }
  return parseTupleAfterLBrack(ctx, lbrack);
}

function parseTupleAfterLBrack(ctx: ExprCursor, lbrack: Token): TupleNode {
  const items: ExprNode[] = [];
  const parts: Array<Token | ExprNode> = [lbrack];
  if (ctx.peek().kind !== TokenKind.RBRACK) {
    for (;;) {
      const item = parseExpression(ctx);
      items.push(item);
      parts.push(item);
      if (ctx.peek().kind === TokenKind.COMMA) {
        parts.push(ctx.consume());
        if (ctx.peek().kind === TokenKind.RBRACK) break;
        continue;
      }
      break;
    }
  }
  const rbrack = expectOrSynth(ctx, TokenKind.RBRACK, "expected ']'");
  parts.push(rbrack);
  return {
    kind: "Tuple",
    range: { start: lbrack.range.start, end: rbrack.range.end },
    parts,
    items,
  };
}

function parseObjectOrFor(ctx: ExprCursor): ObjectNode | ForNode {
  const lbrace = ctx.consume(); // LBRACE
  // Unlike `[ ]`, the lexer keeps newlines inside `{ }` (they separate
  // object items), so a `for` written on the line after the opening brace
  // surfaces a NEWLINE before the keyword. Look past it so multi-line
  // object for-expressions aren't misread as object literals.
  if (isForKeyword(peekPastNewlines(ctx))) {
    return parseForExpression(ctx, lbrace, true);
  }
  return parseObjectAfterLBrace(ctx, lbrace);
}

function parseObjectAfterLBrace(ctx: ExprCursor, lbrace: Token): ObjectNode {
  const items: ObjectItemNode[] = [];
  const parts: Array<Token | ObjectItemNode> = [lbrace];
  // Consume any leading NEWLINEs before the first item (the lexer does
  // not suppress newlines inside braces, so multi-line object literals
  // surface them here as explicit tokens).
  while (ctx.peek().kind === TokenKind.NEWLINE) {
    parts.push(ctx.consume());
  }
  while (ctx.peek().kind !== TokenKind.RBRACE && !ctx.atEnd()) {
    const before = ctx.peek();
    const item = parseObjectItem(ctx);
    // If parseObjectItem made no progress, bail out to avoid spinning.
    // This happens when the parser recovered from repeated failures
    // without consuming a token (e.g., only newlines remaining and no
    // valid key).
    if (ctx.peek() === before) break;
    items.push(item);
    parts.push(item);
    // Separator between items: COMMA (optional trailing), NEWLINE, or
    // directly RBRACE. Consume all trailing commas/newlines before the
    // next item.
    let sawSeparator = false;
    while (true) {
      const after = ctx.peek();
      if (after.kind === TokenKind.COMMA || after.kind === TokenKind.NEWLINE) {
        parts.push(ctx.consume());
        sawSeparator = true;
        continue;
      }
      break;
    }
    if (ctx.peek().kind === TokenKind.RBRACE) break;
    if (!sawSeparator) {
      // No separator and not at closing brace — syntactic error, but we
      // continue so the user sees all their errors at once.
      ctx.errorAtToken(
        ctx.peek(),
        `expected ',' or newline between object items, got ${ctx.peek().kind}`,
      );
      break;
    }
  }
  const rbrace = expectOrSynth(ctx, TokenKind.RBRACE, "expected '}'");
  parts.push(rbrace);
  return {
    kind: "Object",
    range: { start: lbrace.range.start, end: rbrace.range.end },
    parts,
    items,
  };
}

function parseObjectItem(ctx: ExprCursor): ObjectItemNode {
  const key = parseExpression(ctx);
  const sepTok = ctx.peek();
  let separatorToken: Token;
  if (sepTok.kind === TokenKind.ASSIGN || sepTok.kind === TokenKind.COLON) {
    separatorToken = ctx.consume();
  } else {
    ctx.errorAtToken(sepTok, "expected '=' or ':' in object item");
    separatorToken = syntheticToken(TokenKind.ASSIGN, key.range.end);
  }
  const value = parseExpression(ctx);
  return {
    kind: "ObjectItem",
    range: { start: key.range.start, end: value.range.end },
    parts: [key, separatorToken, value],
    key,
    separatorToken,
    value,
  };
}

function parseForExpression(
  ctx: ExprCursor,
  openBrace: Token,
  isObject: boolean,
): ForNode {
  const parts: Array<Token | ExprNode> = [openBrace];
  // Inside an object `{ }`, the lexer emits the newlines of a multi-line
  // for-expression as real NEWLINE tokens (see `shouldSuppressNewlines`).
  // They carry no meaning between for-expression grammar elements, so skip
  // them at every step — threading them into `parts` keeps the round-trip
  // lossless. Tuple for-expressions never see stray newlines (the lexer
  // suppresses them inside `[ ]`), so these calls are no-ops there.
  consumeNewlines(ctx, parts);
  const forToken = ctx.consume(); // IDENT "for"
  parts.push(forToken);

  consumeNewlines(ctx, parts);
  const firstVar = expectOrSynth(
    ctx,
    TokenKind.IDENT,
    "expected iteration variable after 'for'",
  );
  parts.push(firstVar);
  let keyVar: string | null = null;
  let valueVar = firstVar.lexeme;

  consumeNewlines(ctx, parts);
  if (ctx.peek().kind === TokenKind.COMMA) {
    parts.push(ctx.consume());
    consumeNewlines(ctx, parts);
    const second = expectOrSynth(
      ctx,
      TokenKind.IDENT,
      "expected second iteration variable",
    );
    parts.push(second);
    keyVar = firstVar.lexeme;
    valueVar = second.lexeme;
    consumeNewlines(ctx, parts);
  }

  const inTok = ctx.peek();
  if (inTok.kind === TokenKind.IDENT && inTok.lexeme === "in") {
    parts.push(ctx.consume());
  } else {
    ctx.errorAtToken(inTok, "expected 'in' in for expression");
  }

  consumeNewlines(ctx, parts);
  const collection = parseExpression(ctx);
  parts.push(collection);

  consumeNewlines(ctx, parts);
  const colon = expectOrSynth(
    ctx,
    TokenKind.COLON,
    "expected ':' in for expression",
  );
  parts.push(colon);

  let keyExpr: ExprNode | null = null;
  let valueExpr: ExprNode;
  if (isObject) {
    consumeNewlines(ctx, parts);
    keyExpr = parseExpression(ctx);
    parts.push(keyExpr);
    consumeNewlines(ctx, parts);
    const arrow = expectOrSynth(
      ctx,
      TokenKind.FATARROW,
      "expected '=>' in object for",
    );
    parts.push(arrow);
    consumeNewlines(ctx, parts);
    valueExpr = parseExpression(ctx);
    parts.push(valueExpr);
  } else {
    consumeNewlines(ctx, parts);
    valueExpr = parseExpression(ctx);
    parts.push(valueExpr);
  }

  consumeNewlines(ctx, parts);
  let group = false;
  if (isObject && ctx.peek().kind === TokenKind.ELLIPSIS) {
    group = true;
    parts.push(ctx.consume());
    consumeNewlines(ctx, parts);
  }

  let cond: ExprNode | null = null;
  if (ctx.peek().kind === TokenKind.IDENT && ctx.peek().lexeme === "if") {
    parts.push(ctx.consume());
    consumeNewlines(ctx, parts);
    cond = parseExpression(ctx);
    parts.push(cond);
    consumeNewlines(ctx, parts);
  }

  const closeBrace = expectOrSynth(
    ctx,
    isObject ? TokenKind.RBRACE : TokenKind.RBRACK,
    `expected ${isObject ? "'}'" : "']'"} to close for expression`,
  );
  parts.push(closeBrace);

  const node: ForNode = {
    kind: "For",
    range: { start: openBrace.range.start, end: closeBrace.range.end },
    parts,
    isObject,
    keyVar,
    valueVar,
    collection,
    keyExpr,
    valueExpr,
    cond,
    group,
  };
  return node;
}

function isForKeyword(tok: Token): boolean {
  return tok.kind === TokenKind.IDENT && tok.lexeme === "for";
}

/**
 * Consume a run of NEWLINE tokens, appending each to `parts` so the source
 * round-trips byte-for-byte. Used between the grammar elements of a
 * for-expression, where newlines are insignificant yet — inside an object
 * `{ }` — still surface as tokens from the lexer.
 */
function consumeNewlines(
  ctx: ExprCursor,
  parts: Array<Token | ExprNode>,
): void {
  while (ctx.peek().kind === TokenKind.NEWLINE) parts.push(ctx.consume());
}

/**
 * Peek at the next non-NEWLINE token without consuming anything, so the
 * object dispatch can spot a `for` keyword sitting on the line after the
 * opening `{`.
 */
function peekPastNewlines(ctx: ExprCursor): Token {
  let offset = 0;
  while (ctx.peek(offset).kind === TokenKind.NEWLINE) offset++;
  return ctx.peek(offset);
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

function parseQuotedTemplate(ctx: ExprCursor): TemplateNode {
  const openToken = ctx.consume(); // OQUOTE
  return parseTemplateBody(ctx, openToken, TokenKind.CQUOTE, false);
}

function parseHeredocTemplate(ctx: ExprCursor): TemplateNode {
  const openToken = ctx.consume(); // HEREDOC_BEGIN
  return parseTemplateBody(ctx, openToken, TokenKind.HEREDOC_END, true);
}

function parseTemplateBody(
  ctx: ExprCursor,
  openToken: Token,
  endKind: TokenKind,
  isHeredoc: boolean,
): TemplateNode {
  const parts: Array<Token | TemplatePart> = [openToken];
  const templateParts: TemplatePart[] = [];

  while (!ctx.atEnd()) {
    const tok = ctx.peek();
    if (tok.kind === endKind) break;
    if (tok.kind === TokenKind.QUOTED_LIT || tok.kind === TokenKind.INVALID) {
      const part = parseStringPart(ctx);
      parts.push(part);
      templateParts.push(part);
      continue;
    }
    if (tok.kind === TokenKind.TEMPLATE_INTERP) {
      const part = parseInterpolationPart(ctx);
      parts.push(part);
      templateParts.push(part);
      continue;
    }
    if (tok.kind === TokenKind.TEMPLATE_CONTROL) {
      const directive = parseControlDirective(ctx);
      parts.push(directive);
      templateParts.push(directive);
      continue;
    }
    // Anything else inside a template body is a lexer bug or a structural
    // error. Report it and step past it, keeping the token so the CST
    // stays lossless.
    ctx.errorAt(tok.range, `unexpected ${tok.kind} in template body`);
    parts.push(ctx.consume());
  }

  const closeToken = expectOrSynth(ctx, endKind, `expected ${endKind}`);
  parts.push(closeToken);
  return {
    kind: "Template",
    range: { start: openToken.range.start, end: closeToken.range.end },
    parts,
    isHeredoc,
    openToken,
    closeToken,
    templateParts,
  };
}

function parseInterpolationPart(ctx: ExprCursor): TemplateInterpolationPart {
  const open = ctx.consume(); // TEMPLATE_INTERP `${`
  const parts: Array<Token | ExprNode> = [open];
  let stripLeft = false;
  if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
    stripLeft = true;
    parts.push(ctx.consume());
  }
  const expr = parseExpression(ctx);
  parts.push(expr);
  let stripRight = false;
  if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
    stripRight = true;
    parts.push(ctx.consume());
  }
  const close = expectOrSynth(
    ctx,
    TokenKind.TEMPLATE_SEQ_END,
    "expected '}' closing interpolation",
  );
  parts.push(close);
  return {
    kind: "Interpolation",
    range: { start: open.range.start, end: close.range.end },
    parts,
    expr,
    stripLeft,
    stripRight,
  };
}

function parseControlDirective(ctx: ExprCursor): TemplatePart {
  // At this point peek() is TEMPLATE_CONTROL `%{`. We decide the
  // directive based on the IDENT that follows inside the %{ ... }.
  const openToken = ctx.peek();
  const nameLookahead = peekDirectiveName(ctx);
  if (nameLookahead === "if") return parseIfDirective(ctx);
  if (nameLookahead === "for") return parseForDirective(ctx);
  if (isClauseMarker(nameLookahead)) {
    // An else / endif / endfor with no if or for open to take it.
    ctx.errorAt(
      openToken.range,
      `unexpected ${nameLookahead} directive: the control directives in this template are unbalanced`,
    );
    return strayClauseMarker(parseClauseMarker(ctx));
  }
  // Unknown — consume conservatively and emit error. A token the lexer
  // could not read (such as a misplaced `~`) reports its own error.
  const first = ctx.peek(ctx.peek(1).kind === TokenKind.TEMPLATE_STRIP ? 2 : 1);
  if (first.kind === TokenKind.INVALID) {
    ctx.errorAtToken(first, "unknown template directive");
  } else {
    ctx.errorAt(openToken.range, `unknown template directive: %{${nameLookahead ?? "?"}}`);
  }
  // Fall back to treating it as an interpolation-ish sequence so we make
  // progress: consume through the matching %-brace.
  return parseGenericPercentDirective(ctx);
}

/** The markers that continue or close an if / for directive. */
function isClauseMarker(name: string | null): name is "else" | "endif" | "endfor" {
  return name === "else" || name === "endif" || name === "endfor";
}

/** A `%{ [~] else|endif|endfor [~] }` marker, as consumed. */
interface ClauseMarker {
  readonly name: "else" | "endif" | "endfor";
  readonly open: Token;
  /** Every token of the marker, in source order. */
  readonly tokens: Token[];
  readonly nameToken: Token;
  readonly stripLeft: boolean;
  readonly stripRight: boolean;
}

/** Consume a clause marker; peekDirectiveName must have named one. */
function parseClauseMarker(ctx: ExprCursor): ClauseMarker {
  const open = ctx.consume(); // TEMPLATE_CONTROL
  const tokens = [open];
  let stripLeft = false;
  if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
    stripLeft = true;
    tokens.push(ctx.consume());
  }
  const nameToken = ctx.consume(); // IDENT
  tokens.push(nameToken);
  const name = nameToken.lexeme as ClauseMarker["name"];
  let stripRight = false;
  if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
    stripRight = true;
    tokens.push(ctx.consume());
  }
  tokens.push(
    expectOrSynth(ctx, TokenKind.TEMPLATE_SEQ_END, `expected '}' after ${name}`),
  );
  return { name, open, tokens, nameToken, stripLeft, stripRight };
}

/**
 * Keep a clause marker that has no directive to belong to, as an
 * interpolation-shaped part whose expression is an ErrorExpr holding the
 * marker's name, so the CST stays lossless.
 */
function strayClauseMarker(marker: ClauseMarker): TemplateInterpolationPart {
  const expr: ErrorExprNode = {
    kind: "ErrorExpr",
    range: marker.nameToken.range,
    parts: [marker.nameToken],
    message: `unexpected ${marker.name} directive`,
  };
  const last = marker.tokens[marker.tokens.length - 1]!;
  return {
    kind: "Interpolation",
    range: { start: marker.open.range.start, end: last.range.end },
    parts: marker.tokens.map((t) => (t === marker.nameToken ? expr : t)),
    expr,
    stripLeft: marker.stripLeft,
    stripRight: marker.stripRight,
  };
}

/**
 * The token that ends the template a directive sits in: the closing
 * quote or heredoc marker. A directive still open there is missing its
 * end marker.
 */
function isTemplateEnd(tok: Token): boolean {
  return tok.kind === TokenKind.CQUOTE || tok.kind === TokenKind.HEREDOC_END;
}

/** "line L, column C" for the start of `tok`, for messages. */
function placeOf(tok: Token): string {
  return `line ${tok.range.start.line}, column ${tok.range.start.column}`;
}

/** Peek the IDENT inside a `%{...}` without advancing the cursor. */
function peekDirectiveName(ctx: ExprCursor): string | null {
  // TEMPLATE_CONTROL is at offset 0. The IDENT may be at offset 1 or 2
  // (if a strip marker is present).
  let off = 1;
  if (ctx.peek(off).kind === TokenKind.TEMPLATE_STRIP) off++;
  const t = ctx.peek(off);
  return t.kind === TokenKind.IDENT ? t.lexeme : null;
}

function parseIfDirective(ctx: ExprCursor): TemplateIfDirectivePart {
  const ifParts: Array<Token | ExprNode | TemplatePart> = [];
  const ifOpen = ctx.consume(); // TEMPLATE_CONTROL
  ifParts.push(ifOpen);
  let stripLeftIf = false;
  if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
    stripLeftIf = true;
    ifParts.push(ctx.consume());
  }
  ifParts.push(ctx.consume()); // IDENT "if"
  const cond = parseExpression(ctx);
  ifParts.push(cond);
  let stripRightIf = false;
  if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
    stripRightIf = true;
    ifParts.push(ctx.consume());
  }
  ifParts.push(
    expectOrSynth(ctx, TokenKind.TEMPLATE_SEQ_END, "expected '}' after if"),
  );

  const thenParts: TemplatePart[] = [];
  let elseParts: TemplatePart[] | null = null;
  let stripLeftElse = false;
  let stripRightElse = false;
  let stripLeftEndif = false;
  let stripRightEndif = false;
  let doneParts: TemplatePart[] = thenParts;

  // As in hashicorp/hcl, the if ends at its endif, at a marker that
  // cannot belong to it (reported, then consumed), or at the end of the
  // template (reported, and left for the template to close).
  while (!ctx.atEnd()) {
    const tok = ctx.peek();
    if (isTemplateEnd(tok)) {
      ctx.errorAt(
        tok.range,
        `unexpected end of template: the if directive at ${placeOf(ifOpen)} is missing its endif directive`,
      );
      break;
    }
    if (tok.kind === TokenKind.TEMPLATE_CONTROL) {
      const name = peekDirectiveName(ctx);
      if (isClauseMarker(name)) {
        const marker = parseClauseMarker(ctx);
        ifParts.push(...marker.tokens);
        if (name === "else" && elseParts === null) {
          stripLeftElse = marker.stripLeft;
          stripRightElse = marker.stripRight;
          elseParts = [];
          doneParts = elseParts;
          continue;
        }
        if (name === "endif") {
          stripLeftEndif = marker.stripLeft;
          stripRightEndif = marker.stripRight;
          break;
        }
        ctx.errorAt(
          marker.open.range,
          name === "else"
            ? `unexpected else directive: the if directive at ${placeOf(ifOpen)} already has an else clause`
            : `unexpected ${name} directive: expected an endif directive for the if at ${placeOf(ifOpen)}`,
        );
        break;
      }
    }
    // Otherwise: this is nested template content.
    const part = parseTemplateBodyPart(ctx);
    if (!isToken(part)) doneParts.push(part);
    ifParts.push(part);
  }

  const start = ifOpen.range.start;
  const end =
    ifParts.length > 0
      ? partEnd(ifParts[ifParts.length - 1]!)
      : ifOpen.range.end;
  return {
    kind: "IfDirective",
    range: { start, end },
    parts: ifParts,
    cond,
    thenParts,
    elseParts,
    stripLeftIf,
    stripRightIf,
    stripLeftElse,
    stripRightElse,
    stripLeftEndif,
    stripRightEndif,
  };
}

function parseForDirective(ctx: ExprCursor): TemplateForDirectivePart {
  const forParts: Array<Token | ExprNode | TemplatePart> = [];
  const forOpen = ctx.consume(); // TEMPLATE_CONTROL
  forParts.push(forOpen);
  let stripLeftFor = false;
  if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
    stripLeftFor = true;
    forParts.push(ctx.consume());
  }
  forParts.push(ctx.consume()); // IDENT "for"
  const firstVar = expectOrSynth(
    ctx,
    TokenKind.IDENT,
    "expected iteration variable after 'for'",
  );
  forParts.push(firstVar);
  let keyVar: string | null = null;
  let valueVar = firstVar.lexeme;
  if (ctx.peek().kind === TokenKind.COMMA) {
    forParts.push(ctx.consume());
    const second = expectOrSynth(
      ctx,
      TokenKind.IDENT,
      "expected second iteration variable",
    );
    forParts.push(second);
    keyVar = firstVar.lexeme;
    valueVar = second.lexeme;
  }
  // 'in' keyword
  const inTok = ctx.peek();
  if (inTok.kind === TokenKind.IDENT && inTok.lexeme === "in") {
    forParts.push(ctx.consume());
  } else {
    ctx.errorAtToken(inTok, "expected 'in' in template for directive");
  }
  const collection = parseExpression(ctx);
  forParts.push(collection);
  let stripRightFor = false;
  if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
    stripRightFor = true;
    forParts.push(ctx.consume());
  }
  forParts.push(
    expectOrSynth(ctx, TokenKind.TEMPLATE_SEQ_END, "expected '}' after for"),
  );

  const bodyParts: TemplatePart[] = [];
  let stripLeftEndfor = false;
  let stripRightEndfor = false;

  // Ends like an if directive does (see parseIfDirective).
  while (!ctx.atEnd()) {
    const tok = ctx.peek();
    if (isTemplateEnd(tok)) {
      ctx.errorAt(
        tok.range,
        `unexpected end of template: the for directive at ${placeOf(forOpen)} is missing its endfor directive`,
      );
      break;
    }
    if (tok.kind === TokenKind.TEMPLATE_CONTROL) {
      const name = peekDirectiveName(ctx);
      if (isClauseMarker(name)) {
        const marker = parseClauseMarker(ctx);
        forParts.push(...marker.tokens);
        if (name === "endfor") {
          stripLeftEndfor = marker.stripLeft;
          stripRightEndfor = marker.stripRight;
          break;
        }
        ctx.errorAt(
          marker.open.range,
          name === "else"
            ? "unexpected else directive: a for directive cannot have an else clause"
            : `unexpected ${name} directive: expected an endfor directive for the for at ${placeOf(forOpen)}`,
        );
        break;
      }
    }
    const part = parseTemplateBodyPart(ctx);
    if (!isToken(part)) bodyParts.push(part);
    forParts.push(part);
  }

  const start = forOpen.range.start;
  const end =
    forParts.length > 0
      ? partEnd(forParts[forParts.length - 1]!)
      : forOpen.range.end;
  return {
    kind: "ForDirective",
    range: { start, end },
    parts: forParts,
    keyVar,
    valueVar,
    collection,
    bodyParts,
    stripLeftFor,
    stripRightFor,
    stripLeftEndfor,
    stripRightEndfor,
  };
}

/**
 * Consume a run of literal text in a template body. Inside a template the
 * lexer emits INVALID only for a backslash escape HCL does not define or
 * a raw line break in a quoted string: report it, then keep its text as a
 * literal part so the CST stays complete and still prints back byte for
 * byte.
 */
function parseStringPart(ctx: ExprCursor): TemplateStringPart {
  const strTok = ctx.consume();
  if (strTok.kind === TokenKind.INVALID) {
    ctx.errorAtToken(strTok, "invalid template text");
  }
  return {
    kind: "StringPart",
    range: strTok.range,
    parts: [strTok],
    text: strTok.lexeme,
  };
}

/**
 * Parse one part of a directive body. A token that cannot start a part is
 * reported and returned as-is, so the caller keeps it in the directive's
 * `parts` (lossless CST) but not in its list of template parts.
 */
function parseTemplateBodyPart(ctx: ExprCursor): TemplatePart | Token {
  const tok = ctx.peek();
  if (tok.kind === TokenKind.QUOTED_LIT || tok.kind === TokenKind.INVALID) {
    return parseStringPart(ctx);
  }
  if (tok.kind === TokenKind.TEMPLATE_INTERP) {
    return parseInterpolationPart(ctx);
  }
  if (tok.kind === TokenKind.TEMPLATE_CONTROL) {
    return parseControlDirective(ctx);
  }
  // Unknown token inside a template body — consume to make progress.
  ctx.errorAt(tok.range, `unexpected ${tok.kind} in template body`);
  return ctx.consume();
}

function parseGenericPercentDirective(ctx: ExprCursor): TemplateInterpolationPart {
  // Fallback for unknown %{foo} — treat the enclosed IDENT as an
  // expression and wrap as an interpolation-shaped part so the CST
  // stays complete.
  const open = ctx.consume(); // TEMPLATE_CONTROL
  const parts: Array<Token | ExprNode> = [open];
  const expr = parseExpression(ctx);
  parts.push(expr);
  const close = expectOrSynth(
    ctx,
    TokenKind.TEMPLATE_SEQ_END,
    "expected '}' closing directive",
  );
  parts.push(close);
  return {
    kind: "Interpolation",
    range: { start: open.range.start, end: close.range.end },
    parts,
    expr,
    stripLeft: false,
    stripRight: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildBinary(
  left: ExprNode,
  opToken: Token,
  right: ExprNode,
): BinaryOpNode {
  const op = tokenToBinaryOp(opToken.kind);
  return {
    kind: "BinaryOp",
    range: { start: left.range.start, end: right.range.end },
    parts: [left, opToken, right],
    op,
    opToken,
    left,
    right,
  };
}

function tokenToBinaryOp(k: TokenKind): BinaryOp {
  switch (k) {
    case TokenKind.PLUS:
      return "+";
    case TokenKind.MINUS:
      return "-";
    case TokenKind.STAR:
      return "*";
    case TokenKind.SLASH:
      return "/";
    case TokenKind.PERCENT:
      return "%";
    case TokenKind.EQ:
      return "==";
    case TokenKind.NEQ:
      return "!=";
    case TokenKind.LT:
      return "<";
    case TokenKind.LE:
      return "<=";
    case TokenKind.GT:
      return ">";
    case TokenKind.GE:
      return ">=";
    case TokenKind.AND:
      return "&&";
    case TokenKind.OR:
      return "||";
    default:
      throw new Error(`not a binary operator: ${k}`);
  }
}

function expectOrSynth(
  ctx: ExprCursor,
  kind: TokenKind,
  message: string,
): Token {
  const tok = ctx.peek();
  if (tok.kind === kind) return ctx.consume();
  ctx.errorAtToken(tok, message);
  return syntheticToken(kind, tok.range.start);
}

function syntheticToken(kind: TokenKind, at: Range["start"]): Token {
  return {
    kind,
    lexeme: "",
    leadingTrivia: "",
    trailingTrivia: "",
    range: { start: at, end: at },
  };
}

function errorExpr(ctx: ExprCursor, message: string): ErrorExprNode {
  const tok = ctx.peek();
  const pos = tok.range.start;
  return {
    kind: "ErrorExpr",
    range: { start: pos, end: pos },
    parts: [],
    message,
  };
}

function partEnd(
  part: Token | ExprNode | TemplatePart,
): Range["end"] {
  // Every Token and node type exposes `range.end`.
  return part.range.end;
}

const INVALID_ATTRIBUTE_NAME =
  "invalid attribute name: an attribute name is required after a dot";

const NESTED_SPLAT =
  "nested splat expression not allowed: a splat (*) cannot be used inside " +
  "an attribute-only splat (.*)";

// Avoid unused-import complaints if HCLParseError's side-effects are
// needed in future expansions.
void HCLParseError;
