/**
 * HCL2 lexer output: token kinds and the Token record produced by the lexer.
 *
 * The lexer emits a stream of Token records in source order. Each record
 * captures its leading trivia (whitespace / comments / bracket-suppressed
 * newlines that precede it), its lexeme (the verbatim source slice that
 * represents the token itself), and its same-line trailing trivia. Those
 * three strings, concatenated for every token in order, reproduce the input
 * source byte-for-byte — this is the lex-rejoin invariant the tests verify.
 *
 * Token kinds match the taxonomy in docs/design.md §5.1. Heredoc body
 * content reuses the same QUOTED_LIT / TEMPLATE_INTERP / TEMPLATE_CONTROL
 * tokens as quoted strings; there is no separate per-line heredoc token
 * because interpolations can appear mid-line.
 */

import type { Range } from "../source.js";

/**
 * Canonical token kinds. Values are kept as string literals (rather than
 * numeric enums) so failing test output is immediately readable.
 */
export const TokenKind = {
  // Literals
  NUMBER: "NUMBER",
  IDENT: "IDENT",

  // Punctuation
  LBRACE: "LBRACE",
  RBRACE: "RBRACE",
  LBRACK: "LBRACK",
  RBRACK: "RBRACK",
  LPAREN: "LPAREN",
  RPAREN: "RPAREN",
  COMMA: "COMMA",
  DOT: "DOT",
  ELLIPSIS: "ELLIPSIS",
  COLON: "COLON",
  QUESTION: "QUESTION",
  FATARROW: "FATARROW",

  // Operators
  PLUS: "PLUS",
  MINUS: "MINUS",
  STAR: "STAR",
  SLASH: "SLASH",
  PERCENT: "PERCENT",
  EQ: "EQ",
  NEQ: "NEQ",
  LT: "LT",
  LE: "LE",
  GT: "GT",
  GE: "GE",
  AND: "AND",
  OR: "OR",
  BANG: "BANG",
  ASSIGN: "ASSIGN",

  // Template structure
  OQUOTE: "OQUOTE",
  CQUOTE: "CQUOTE",
  QUOTED_LIT: "QUOTED_LIT",
  TEMPLATE_INTERP: "TEMPLATE_INTERP",
  TEMPLATE_CONTROL: "TEMPLATE_CONTROL",
  TEMPLATE_SEQ_END: "TEMPLATE_SEQ_END",
  TEMPLATE_STRIP: "TEMPLATE_STRIP",
  HEREDOC_BEGIN: "HEREDOC_BEGIN",
  HEREDOC_END: "HEREDOC_END",

  // Structural
  NEWLINE: "NEWLINE",
  EOF: "EOF",

  // Synthetic — carries a human-readable error message for recovery.
  INVALID: "INVALID",
} as const;

export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

/**
 * One lexical token. The lex-rejoin invariant on a token stream `ts` is:
 *
 *     ts.map(t => t.leadingTrivia + t.lexeme + t.trailingTrivia).join("")
 *     === source
 */
export interface Token {
  readonly kind: TokenKind;
  /** Verbatim source slice for the token itself (without trivia). */
  readonly lexeme: string;
  /** Whitespace / comments / suppressed newlines preceding the lexeme. */
  readonly leadingTrivia: string;
  /** Same-line whitespace / comment trailing the lexeme, up to (but not
   *  including) the next newline or non-trivia character. */
  readonly trailingTrivia: string;
  /** Span of the lexeme itself in the source file. Does not include trivia. */
  readonly range: Range;
  /**
   * Only set on INVALID tokens. Human-readable explanation of what went
   * wrong at `range.start`. Other token kinds leave this undefined.
   */
  readonly error?: string;
}
