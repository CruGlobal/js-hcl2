/**
 * Concrete-syntax-tree (CST) node types produced by the parser.
 *
 * Every `parts` array contains the node's direct children in source
 * order — a mix of Tokens (lexemes with trivia) and sub-nodes. Walking
 * `parts` recursively and emitting trivia + lexeme for each Token
 * reproduces the input byte-for-byte; that's the foundation for the
 * lossless Document API in M7.
 *
 * The outer structural nodes (Body, Attribute, Block, BlockLabels) were
 * introduced in M3. M4 replaces M3's opaque ExpressionNode with a full
 * expression AST (the `ExprNode` union below).
 */

import type { Range } from "../source.js";
import type { Token } from "../lexer/token.js";

// ─────────────────────────────────────────────────────────────────────────────
// Top-level structural nodes (shaped in M3)
// ─────────────────────────────────────────────────────────────────────────────

export type NodeKind =
  | "Body"
  | "Attribute"
  | "Block"
  | "BlockLabels"
  | ExprNodeKind;

/**
 * Top-level union of every CST node. `Node` does not include the
 * fine-grained "part" structures (TemplatePart, TraversalStep,
 * ObjectItem) — those are always accessed as children of a larger
 * ExprNode.
 */
export type Node =
  | BodyNode
  | AttributeNode
  | BlockNode
  | BlockLabelsNode
  | ExprNode;

interface NodeBase {
  readonly kind: NodeKind;
  readonly range: Range;
}

export interface BodyNode extends NodeBase {
  readonly kind: "Body";
  readonly parts: ReadonlyArray<AttributeNode | BlockNode | Token>;
  readonly attributes: ReadonlyArray<AttributeNode>;
  readonly blocks: ReadonlyArray<BlockNode>;
}

export interface AttributeNode extends NodeBase {
  readonly kind: "Attribute";
  readonly parts: readonly [Token, Token, ExprNode];
  readonly name: string;
  readonly expression: ExprNode;
}

export interface BlockNode extends NodeBase {
  readonly kind: "Block";
  readonly parts: ReadonlyArray<Token | BlockLabelsNode | BodyNode>;
  readonly type: string;
  readonly labels: BlockLabelsNode | null;
  readonly body: BodyNode;
}

export interface BlockLabelsNode extends NodeBase {
  readonly kind: "BlockLabels";
  readonly parts: ReadonlyArray<Token>;
  readonly labels: ReadonlyArray<LabelInfo>;
}

export interface LabelInfo {
  readonly value: string;
  readonly quoted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expression AST (M4)
// ─────────────────────────────────────────────────────────────────────────────

export type ExprNodeKind =
  | "Literal"
  | "Template"
  | "Tuple"
  | "Object"
  | "ObjectItem"
  | "Variable"
  | "Traversal"
  | "Splat"
  | "Call"
  | "For"
  | "Conditional"
  | "BinaryOp"
  | "UnaryOp"
  | "Parens"
  | "ErrorExpr";

/** Union of every concrete expression node. */
export type ExprNode =
  | LiteralNode
  | TemplateNode
  | TupleNode
  | ObjectNode
  | VariableNode
  | TraversalNode
  | SplatNode
  | FunctionCallNode
  | ForNode
  | ConditionalNode
  | BinaryOpNode
  | UnaryOpNode
  | ParensNode
  | ErrorExprNode;

/**
 * Number / boolean / null literal. String literals are represented as
 * TemplateNode with a single StringPart, because every "..." string in
 * HCL is syntactically a template (possibly with no interpolations).
 */
export interface LiteralNode extends NodeBase {
  readonly kind: "Literal";
  readonly parts: readonly [Token];
  readonly valueType: "number" | "boolean" | "null";
  readonly value: number | boolean | null;
}

/**
 * Quoted string or heredoc. `templateParts` is the structured view of
 * the body (string runs, interpolations, directives); `parts` is the
 * flat source-order list used for printing.
 */
export interface TemplateNode extends NodeBase {
  readonly kind: "Template";
  readonly parts: ReadonlyArray<Token | TemplatePart>;
  readonly isHeredoc: boolean;
  readonly openToken: Token; // OQUOTE or HEREDOC_BEGIN
  readonly closeToken: Token; // CQUOTE or HEREDOC_END
  readonly templateParts: ReadonlyArray<TemplatePart>;
}

export type TemplatePart =
  | TemplateStringPart
  | TemplateInterpolationPart
  | TemplateIfDirectivePart
  | TemplateForDirectivePart;

export type TemplatePartKind =
  | "StringPart"
  | "Interpolation"
  | "IfDirective"
  | "ForDirective";

interface TemplatePartBase {
  readonly kind: TemplatePartKind;
  readonly range: Range;
  readonly parts: ReadonlyArray<Token | ExprNode | TemplatePart>;
}

export interface TemplateStringPart extends TemplatePartBase {
  readonly kind: "StringPart";
  readonly parts: readonly [Token];
  readonly text: string; // the QUOTED_LIT lexeme, verbatim
}

export interface TemplateInterpolationPart extends TemplatePartBase {
  readonly kind: "Interpolation";
  readonly parts: ReadonlyArray<Token | ExprNode>;
  readonly expr: ExprNode;
  readonly stripLeft: boolean;
  readonly stripRight: boolean;
}

export interface TemplateIfDirectivePart extends TemplatePartBase {
  readonly kind: "IfDirective";
  readonly parts: ReadonlyArray<Token | ExprNode | TemplatePart>;
  readonly cond: ExprNode;
  readonly thenParts: ReadonlyArray<TemplatePart>;
  readonly elseParts: ReadonlyArray<TemplatePart> | null;
  readonly stripLeftIf: boolean;
  readonly stripRightIf: boolean;
  readonly stripLeftElse: boolean;
  readonly stripRightElse: boolean;
  readonly stripLeftEndif: boolean;
  readonly stripRightEndif: boolean;
}

export interface TemplateForDirectivePart extends TemplatePartBase {
  readonly kind: "ForDirective";
  readonly parts: ReadonlyArray<Token | ExprNode | TemplatePart>;
  readonly keyVar: string | null;
  readonly valueVar: string;
  readonly collection: ExprNode;
  readonly bodyParts: ReadonlyArray<TemplatePart>;
  readonly stripLeftFor: boolean;
  readonly stripRightFor: boolean;
  readonly stripLeftEndfor: boolean;
  readonly stripRightEndfor: boolean;
}

/** `[a, b, c]` tuple constructor. */
export interface TupleNode extends NodeBase {
  readonly kind: "Tuple";
  readonly parts: ReadonlyArray<Token | ExprNode>;
  readonly items: ReadonlyArray<ExprNode>;
}

/** `{a = 1, b = 2}` or `{a: 1, b: 2}` object constructor. */
export interface ObjectNode extends NodeBase {
  readonly kind: "Object";
  readonly parts: ReadonlyArray<Token | ObjectItemNode>;
  readonly items: ReadonlyArray<ObjectItemNode>;
}

export interface ObjectItemNode extends NodeBase {
  readonly kind: "ObjectItem";
  readonly parts: readonly [ExprNode, Token, ExprNode];
  readonly key: ExprNode;
  readonly separatorToken: Token; // ASSIGN or COLON
  readonly value: ExprNode;
}

/** Bare identifier reference (not true/false/null, those are Literals). */
export interface VariableNode extends NodeBase {
  readonly kind: "Variable";
  readonly parts: readonly [Token];
  readonly name: string;
}

/**
 * Attribute access and/or indexing chain: `source.a[0].b`. Splats are
 * represented separately via `SplatNode` — a TraversalNode never
 * contains a splat step.
 */
export interface TraversalNode extends NodeBase {
  readonly kind: "Traversal";
  readonly parts: ReadonlyArray<Token | ExprNode>;
  readonly source: ExprNode;
  readonly steps: ReadonlyArray<TraversalStep>;
}

export type TraversalStep = GetAttrStep | IndexStep;

export interface GetAttrStep {
  readonly kind: "GetAttr";
  readonly range: Range;
  readonly dotToken: Token;
  readonly nameToken: Token;
  readonly name: string;
}

export interface IndexStep {
  readonly kind: "Index";
  readonly range: Range;
  readonly lbrackToken: Token;
  readonly key: ExprNode;
  readonly rbrackToken: Token;
}

/**
 * Attribute-only (`source.*.a.b`) or full (`source[*].a.b`) splat.
 * Steps after the splat marker are collected into `each`.
 */
export interface SplatNode extends NodeBase {
  readonly kind: "Splat";
  readonly parts: ReadonlyArray<Token | ExprNode>;
  readonly source: ExprNode;
  readonly style: "attr" | "full";
  readonly each: ReadonlyArray<TraversalStep>;
}

/**
 * `name(arg1, arg2, ...)` call. `expandFinal` is true when the final
 * argument is followed by `...` (variadic expansion).
 */
export interface FunctionCallNode extends NodeBase {
  readonly kind: "Call";
  readonly parts: ReadonlyArray<Token | ExprNode>;
  readonly name: string;
  readonly nameToken: Token;
  readonly args: ReadonlyArray<ExprNode>;
  readonly expandFinal: boolean;
}

/**
 * `[for k, v in collection : expr if cond]` tuple-for, or
 * `{for k, v in collection : key => value ... if cond}` object-for.
 */
export interface ForNode extends NodeBase {
  readonly kind: "For";
  readonly parts: ReadonlyArray<Token | ExprNode>;
  readonly isObject: boolean;
  /** First iteration variable (present only for `for k, v in ...`). */
  readonly keyVar: string | null;
  /** Second (or only) iteration variable — always present. */
  readonly valueVar: string;
  readonly collection: ExprNode;
  /** Object-form key expression (null for tuple-for). */
  readonly keyExpr: ExprNode | null;
  readonly valueExpr: ExprNode;
  /** Optional `if cond` filter clause. */
  readonly cond: ExprNode | null;
  /** Object-form `...` grouping marker. */
  readonly group: boolean;
}

/** `cond ? then : else_`. */
export interface ConditionalNode extends NodeBase {
  readonly kind: "Conditional";
  readonly parts: readonly [ExprNode, Token, ExprNode, Token, ExprNode];
  readonly cond: ExprNode;
  readonly questionToken: Token;
  readonly then: ExprNode;
  readonly colonToken: Token;
  readonly else_: ExprNode;
}

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||";

export interface BinaryOpNode extends NodeBase {
  readonly kind: "BinaryOp";
  readonly parts: readonly [ExprNode, Token, ExprNode];
  readonly op: BinaryOp;
  readonly opToken: Token;
  readonly left: ExprNode;
  readonly right: ExprNode;
}

export type UnaryOp = "-" | "!";

export interface UnaryOpNode extends NodeBase {
  readonly kind: "UnaryOp";
  readonly parts: readonly [Token, ExprNode];
  readonly op: UnaryOp;
  readonly opToken: Token;
  readonly operand: ExprNode;
}

/** `(expr)` — preserved for round-trip fidelity and associativity hints. */
export interface ParensNode extends NodeBase {
  readonly kind: "Parens";
  readonly parts: readonly [Token, ExprNode, Token];
  readonly inner: ExprNode;
}

/**
 * Synthetic placeholder emitted when the parser cannot produce a valid
 * expression (e.g., `attr =` with nothing after). Wraps any tokens
 * collected during error recovery so the CST is always complete and
 * round-trip is preserved.
 */
export interface ErrorExprNode extends NodeBase {
  readonly kind: "ErrorExpr";
  readonly parts: ReadonlyArray<Token>;
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type guards
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if `x` is a lexer Token (as opposed to any CST node). */
export function isToken(x: unknown): x is Token {
  return typeof x === "object" && x !== null && "lexeme" in x;
}

/**
 * Any object with a `parts` array that the print walker can descend
 * into. Covers all node types plus the template/traversal sub-parts.
 */
export interface PartsHolder {
  readonly parts: ReadonlyArray<PartsHolder | Token>;
}
