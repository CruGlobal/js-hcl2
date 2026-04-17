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
    ctx.errorAt(ctx.peek().range, "expected ':' in conditional expression");
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
  let expr = parsePrimary(ctx);
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
  const next = ctx.peek();

  if (next.kind === TokenKind.STAR) {
    // Attribute splat: source.*.a.b
    const starToken = ctx.consume();
    const each: TraversalStep[] = [];
    const parts: Array<Token | ExprNode> = [source, dotToken, starToken];
    while (true) {
      const t = ctx.peek();
      if (t.kind === TokenKind.DOT) {
        const step = parseGetAttrStep(ctx);
        each.push(step);
        parts.push(step.dotToken, step.nameToken);
        continue;
      }
      if (t.kind === TokenKind.LBRACK) {
        const step = parseIndexStep(ctx);
        each.push(step);
        parts.push(step.lbrackToken, step.key, step.rbrackToken);
        continue;
      }
      break;
    }
    const last = each.length > 0 ? each[each.length - 1]! : null;
    const end = last
      ? last.kind === "GetAttr"
        ? last.nameToken.range.end
        : last.rbrackToken.range.end
      : starToken.range.end;
    const node: SplatNode = {
      kind: "Splat",
      range: { start: source.range.start, end },
      parts,
      source,
      style: "attr",
      each,
    };
    return node;
  }

  if (next.kind === TokenKind.IDENT) {
    // Regular get-attr.
    return appendTraversalStep(source, parseGetAttrStepFromDot(ctx, dotToken));
  }

  if (next.kind === TokenKind.NUMBER) {
    // Legacy integer traversal: a.0 — treated here as a synthetic GetAttr
    // carrying the number token as the "name" for round-trip; semantic
    // evaluation in M5+ will interpret it as an index.
    const nameToken = ctx.consume();
    const step: GetAttrStep = {
      kind: "GetAttr",
      range: { start: dotToken.range.start, end: nameToken.range.end },
      dotToken,
      nameToken,
      name: nameToken.lexeme,
    };
    return appendTraversalStep(source, step);
  }

  ctx.errorAt(next.range, `expected identifier after '.', got ${next.kind}`);
  // Recover: synthesize an empty GetAttr step.
  const synth = syntheticToken(TokenKind.IDENT, dotToken.range.end);
  const step: GetAttrStep = {
    kind: "GetAttr",
    range: { start: dotToken.range.start, end: synth.range.end },
    dotToken,
    nameToken: synth,
    name: "",
  };
  return appendTraversalStep(source, step);
}

function parseGetAttrStepFromDot(
  ctx: ExprCursor,
  dotToken: Token,
): GetAttrStep {
  const nameToken = ctx.consume(); // IDENT
  return {
    kind: "GetAttr",
    range: { start: dotToken.range.start, end: nameToken.range.end },
    dotToken,
    nameToken,
    name: nameToken.lexeme,
  };
}

function parseGetAttrStep(ctx: ExprCursor): GetAttrStep {
  const dotToken = ctx.consume(); // DOT
  return parseGetAttrStepFromDot(ctx, dotToken);
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

function parseAfterLBrack(ctx: ExprCursor, source: ExprNode): ExprNode {
  // Look ahead for full splat [*]
  const first = ctx.peek(1);
  const second = ctx.peek(2);
  if (first.kind === TokenKind.STAR && second.kind === TokenKind.RBRACK) {
    const lbrackToken = ctx.consume();
    const starToken = ctx.consume();
    const rbrackToken = ctx.consume();
    const each: TraversalStep[] = [];
    const parts: Array<Token | ExprNode> = [
      source,
      lbrackToken,
      starToken,
      rbrackToken,
    ];
    while (true) {
      const t = ctx.peek();
      if (t.kind === TokenKind.DOT) {
        const step = parseGetAttrStep(ctx);
        each.push(step);
        parts.push(step.dotToken, step.nameToken);
        continue;
      }
      if (t.kind === TokenKind.LBRACK) {
        const step = parseIndexStep(ctx);
        each.push(step);
        parts.push(step.lbrackToken, step.key, step.rbrackToken);
        continue;
      }
      break;
    }
    const last = each.length > 0 ? each[each.length - 1]! : null;
    const end = last
      ? last.kind === "GetAttr"
        ? last.nameToken.range.end
        : last.rbrackToken.range.end
      : rbrackToken.range.end;
    const node: SplatNode = {
      kind: "Splat",
      range: { start: source.range.start, end },
      parts,
      source,
      style: "full",
      each,
    };
    return node;
  }
  // Regular index.
  return appendTraversalStep(source, parseIndexStep(ctx));
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
      // Function call? `name(...)` — trivia-insensitive peek for LPAREN.
      if (ctx.peek(1).kind === TokenKind.LPAREN) {
        return parseCall(ctx);
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
      ctx.errorAt(tok.range, `expected expression, got ${tok.kind}`);
      return errorExpr(ctx, `expected expression, got ${tok.kind}`);
  }
}

function parseCall(ctx: ExprCursor): FunctionCallNode {
  const nameToken = ctx.consume(); // IDENT
  const lparen = ctx.consume(); // LPAREN
  const args: ExprNode[] = [];
  const parts: Array<Token | ExprNode> = [nameToken, lparen];
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
    name: nameToken.lexeme,
    nameToken,
    args,
    expandFinal,
  };
  return node;
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
  if (isForKeyword(ctx.peek())) {
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
      ctx.errorAt(
        ctx.peek().range,
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
    ctx.errorAt(sepTok.range, "expected '=' or ':' in object item");
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
  const forToken = ctx.consume(); // IDENT "for"
  const parts: Array<Token | ExprNode> = [openBrace, forToken];

  const firstVar = expectOrSynth(
    ctx,
    TokenKind.IDENT,
    "expected iteration variable after 'for'",
  );
  parts.push(firstVar);
  let keyVar: string | null = null;
  let valueVar = firstVar.lexeme;

  if (ctx.peek().kind === TokenKind.COMMA) {
    parts.push(ctx.consume());
    const second = expectOrSynth(
      ctx,
      TokenKind.IDENT,
      "expected second iteration variable",
    );
    parts.push(second);
    keyVar = firstVar.lexeme;
    valueVar = second.lexeme;
  }

  const inTok = ctx.peek();
  if (inTok.kind === TokenKind.IDENT && inTok.lexeme === "in") {
    parts.push(ctx.consume());
  } else {
    ctx.errorAt(inTok.range, "expected 'in' in for expression");
  }

  const collection = parseExpression(ctx);
  parts.push(collection);

  const colon = expectOrSynth(
    ctx,
    TokenKind.COLON,
    "expected ':' in for expression",
  );
  parts.push(colon);

  let keyExpr: ExprNode | null = null;
  let valueExpr: ExprNode;
  if (isObject) {
    keyExpr = parseExpression(ctx);
    parts.push(keyExpr);
    const arrow = expectOrSynth(
      ctx,
      TokenKind.FATARROW,
      "expected '=>' in object for",
    );
    parts.push(arrow);
    valueExpr = parseExpression(ctx);
    parts.push(valueExpr);
  } else {
    valueExpr = parseExpression(ctx);
    parts.push(valueExpr);
  }

  let group = false;
  if (isObject && ctx.peek().kind === TokenKind.ELLIPSIS) {
    group = true;
    parts.push(ctx.consume());
  }

  let cond: ExprNode | null = null;
  if (ctx.peek().kind === TokenKind.IDENT && ctx.peek().lexeme === "if") {
    parts.push(ctx.consume());
    cond = parseExpression(ctx);
    parts.push(cond);
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
    if (tok.kind === TokenKind.QUOTED_LIT) {
      const strTok = ctx.consume();
      const part: TemplateStringPart = {
        kind: "StringPart",
        range: strTok.range,
        parts: [strTok],
        text: strTok.lexeme,
      };
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
    // Anything else inside a template body is a lexer bug or structural
    // error — emit and try to make progress.
    ctx.errorAt(tok.range, `unexpected ${tok.kind} in template body`);
    ctx.consume();
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
  // Unknown — consume conservatively and emit error.
  ctx.errorAt(openToken.range, `unknown template directive: %{${nameLookahead ?? "?"}}`);
  // Fall back to treating it as an interpolation-ish sequence so we make
  // progress: consume through the matching %-brace.
  return parseGenericPercentDirective(ctx);
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

  while (!ctx.atEnd()) {
    const tok = ctx.peek();
    if (tok.kind === TokenKind.TEMPLATE_CONTROL) {
      const name = peekDirectiveName(ctx);
      if (name === "else" || name === "endif") {
        // Consume the %{ [~] (else|endif) [~] } sequence.
        const open = ctx.consume();
        ifParts.push(open);
        let stripLeft = false;
        if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
          stripLeft = true;
          ifParts.push(ctx.consume());
        }
        const nameTok = ctx.consume();
        ifParts.push(nameTok);
        let stripRight = false;
        if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
          stripRight = true;
          ifParts.push(ctx.consume());
        }
        ifParts.push(
          expectOrSynth(
            ctx,
            TokenKind.TEMPLATE_SEQ_END,
            `expected '}' after ${name}`,
          ),
        );
        if (name === "else") {
          stripLeftElse = stripLeft;
          stripRightElse = stripRight;
          elseParts = [];
          doneParts = elseParts;
          continue;
        }
        // endif
        stripLeftEndif = stripLeft;
        stripRightEndif = stripRight;
        break;
      }
    }
    // Otherwise: this is nested template content.
    const part = parseTemplateBodyPart(ctx);
    if (part) {
      doneParts.push(part);
      ifParts.push(part);
    }
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
    ctx.errorAt(inTok.range, "expected 'in' in template for directive");
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

  while (!ctx.atEnd()) {
    const tok = ctx.peek();
    if (tok.kind === TokenKind.TEMPLATE_CONTROL) {
      if (peekDirectiveName(ctx) === "endfor") {
        const open = ctx.consume();
        forParts.push(open);
        if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
          stripLeftEndfor = true;
          forParts.push(ctx.consume());
        }
        forParts.push(ctx.consume()); // IDENT "endfor"
        if (ctx.peek().kind === TokenKind.TEMPLATE_STRIP) {
          stripRightEndfor = true;
          forParts.push(ctx.consume());
        }
        forParts.push(
          expectOrSynth(
            ctx,
            TokenKind.TEMPLATE_SEQ_END,
            "expected '}' after endfor",
          ),
        );
        break;
      }
    }
    const part = parseTemplateBodyPart(ctx);
    if (part) {
      bodyParts.push(part);
      forParts.push(part);
    }
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

function parseTemplateBodyPart(ctx: ExprCursor): TemplatePart | null {
  const tok = ctx.peek();
  if (tok.kind === TokenKind.QUOTED_LIT) {
    const strTok = ctx.consume();
    return {
      kind: "StringPart",
      range: strTok.range,
      parts: [strTok],
      text: strTok.lexeme,
    };
  }
  if (tok.kind === TokenKind.TEMPLATE_INTERP) {
    return parseInterpolationPart(ctx);
  }
  if (tok.kind === TokenKind.TEMPLATE_CONTROL) {
    return parseControlDirective(ctx);
  }
  // Unknown token inside a template body — consume to make progress.
  ctx.errorAt(tok.range, `unexpected ${tok.kind} in template body`);
  ctx.consume();
  return null;
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
  ctx.errorAt(tok.range, message);
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

// Avoid unused-import complaints if HCLParseError's side-effects are
// needed in future expansions.
void HCLParseError;
