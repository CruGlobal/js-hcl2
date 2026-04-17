/**
 * Lossless CST → text printer. Walks the `parts` array of each node in
 * source order, emitting `leadingTrivia + lexeme + trailingTrivia` for
 * each Token and recursing into child Nodes. By construction, this
 * produces the original source byte-for-byte for any tree that the M3
 * parser built — provided the parser has placed every lexer Token into
 * exactly one node's `parts`.
 */

import type { Token } from "../lexer/token.js";
import type { Node } from "./nodes.js";
import { isToken } from "./nodes.js";

/** Print a CST node (or a single Token) back to its source representation. */
export function print(node: Node | Token): string {
  if (isToken(node)) return node.leadingTrivia + node.lexeme + node.trailingTrivia;
  let out = "";
  for (const part of node.parts) {
    out += print(part);
  }
  return out;
}
