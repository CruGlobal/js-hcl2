/**
 * Concrete-syntax-tree (CST) node types produced by the M3 structural
 * parser. The CST is trivia-aware: every Token emitted by the lexer
 * appears in exactly one node's `parts` array, so walking the tree and
 * concatenating `token.leadingTrivia + token.lexeme + token.trailingTrivia`
 * for each token (recursing into child nodes at their source position)
 * reproduces the input byte-for-byte. This is the load-bearing contract
 * for the lossless Document API in M7.
 *
 * Design choices (see docs/design.md §7):
 *
 * - `parts` is a flat, ordered array mixing child `Node`s and `Token`s.
 *   That makes printing trivially linear and avoids bespoke traversal
 *   code per node kind. Convenience accessors (`BodyNode.attributes`,
 *   `BlockNode.labels`, etc.) surface the structural bits for consumers
 *   that don't need the raw trivia.
 *
 * - NEWLINE tokens terminating a statement live at the `BodyNode` level,
 *   between statement nodes — *not* inside `AttributeNode` / `BlockNode`.
 *   This gives blank lines a natural home and makes statement
 *   extraction/reordering clean (moving an attribute doesn't take an
 *   artifact newline with it).
 *
 * - `ExpressionNode` in M3 is intentionally *opaque*: `parts` is a flat
 *   token run. M4 replaces the shape with a full expression AST, but the
 *   outer surface (`range`, `parts`) is stable so the body/attribute
 *   parsers don't need to change.
 */

import type { Range } from "../source.js";
import type { Token } from "../lexer/token.js";

/** Discriminator for all CST node kinds. */
export type NodeKind =
  | "Body"
  | "Attribute"
  | "Block"
  | "BlockLabels"
  | "Expression";

/** Union of every node produced by the parser. */
export type Node =
  | BodyNode
  | AttributeNode
  | BlockNode
  | BlockLabelsNode
  | ExpressionNode;

/** Shared fields on every node. */
interface NodeBase {
  readonly kind: NodeKind;
  readonly range: Range;
}

/** Top-level body of a config file, or the body of a multi-line block. */
export interface BodyNode extends NodeBase {
  readonly kind: "Body";
  /** Source-order interleaving of statements with NEWLINE separators. */
  readonly parts: ReadonlyArray<AttributeNode | BlockNode | Token>;
  /** Convenience view: every attribute declared directly in this body. */
  readonly attributes: ReadonlyArray<AttributeNode>;
  /** Convenience view: every block declared directly in this body. */
  readonly blocks: ReadonlyArray<BlockNode>;
}

/** `name = expression` (NEWLINE lives on the enclosing BodyNode). */
export interface AttributeNode extends NodeBase {
  readonly kind: "Attribute";
  /** Always `[IDENT, ASSIGN, ExpressionNode]`. */
  readonly parts: readonly [Token, Token, ExpressionNode];
  /** Attribute identifier text (lexeme of the IDENT token). */
  readonly name: string;
  /** The right-hand side expression (opaque token span in M3). */
  readonly expression: ExpressionNode;
}

/**
 * `type labels... { body }`. The `labels` node is optional (absent when
 * the block has zero labels); the body is always present but may be
 * empty.
 */
export interface BlockNode extends NodeBase {
  readonly kind: "Block";
  /** `[IDENT, BlockLabelsNode?, LBRACE, BodyNode, RBRACE]`. */
  readonly parts: ReadonlyArray<Token | BlockLabelsNode | BodyNode>;
  /** Block type identifier (first IDENT, before any labels). */
  readonly type: string;
  /** Labels, or null if the block has no labels. */
  readonly labels: BlockLabelsNode | null;
  /** Block body. Empty (no attributes / no blocks) for `foo {}`. */
  readonly body: BodyNode;
}

/**
 * A run of labels between the block type identifier and `{`. Each label
 * is either a bare identifier (IDENT) or a quoted literal (OQUOTE +
 * QUOTED_LIT + CQUOTE).
 */
export interface BlockLabelsNode extends NodeBase {
  readonly kind: "BlockLabels";
  /** Source-ordered run of label tokens. */
  readonly parts: ReadonlyArray<Token>;
  /**
   * Convenience view of each label. `value` is the bare identifier text
   * or the quoted-literal text (without the surrounding `"`); `quoted`
   * indicates which form was used in source.
   */
  readonly labels: ReadonlyArray<LabelInfo>;
}

export interface LabelInfo {
  readonly value: string;
  readonly quoted: boolean;
}

/**
 * Right-hand side of an attribute. In M3 this is an *opaque* token span:
 * `parts` is a flat list of Tokens, with no sub-structure. M4 replaces
 * the internal shape with a real expression AST while keeping the outer
 * surface (kind, range, parts as a readable array) stable for downstream
 * code.
 */
export interface ExpressionNode extends NodeBase {
  readonly kind: "Expression";
  readonly parts: ReadonlyArray<Token>;
}

/** Type guard: distinguish a Token from a Node. */
export function isToken(x: Node | Token): x is Token {
  return "lexeme" in x;
}
