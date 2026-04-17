import { describe, expect, it } from "vitest";
import { lex } from "../../src/lexer/lexer.js";
import type { Token } from "../../src/lexer/token.js";
import { TokenKind } from "../../src/lexer/token.js";
import { SourceFile } from "../../src/source.js";

function tokens(input: string): Token[] {
  return lex(new SourceFile(input));
}

function kindsOnly(input: string): TokenKind[] {
  return tokens(input).map((t) => t.kind);
}

/** Assert lex(input) → input round-trips via leadingTrivia+lexeme+trailingTrivia. */
function expectRejoin(input: string): void {
  const t = tokens(input);
  const joined = t
    .map((tk) => tk.leadingTrivia + tk.lexeme + tk.trailingTrivia)
    .join("");
  expect(joined).toBe(input);
}

describe("per token kind", () => {
  const cases: Array<{ input: string; kind: TokenKind; lexeme?: string }> = [
    // Literals
    { input: "123", kind: TokenKind.NUMBER },
    { input: "0.5", kind: TokenKind.NUMBER },
    { input: "1e10", kind: TokenKind.NUMBER },
    { input: "2.5E-3", kind: TokenKind.NUMBER },
    { input: "foo", kind: TokenKind.IDENT },
    { input: "foo-bar", kind: TokenKind.IDENT },
    { input: "_underscore", kind: TokenKind.IDENT, lexeme: "_underscore" },
    // ^ underscore is NOT UAX #31 ID_Start, so this should NOT be IDENT.
    //   We verify the negative below.
    // Punctuation
    { input: "{", kind: TokenKind.LBRACE },
    { input: "}", kind: TokenKind.RBRACE },
    { input: "[", kind: TokenKind.LBRACK },
    { input: "]", kind: TokenKind.RBRACK },
    { input: "(", kind: TokenKind.LPAREN },
    { input: ")", kind: TokenKind.RPAREN },
    { input: ",", kind: TokenKind.COMMA },
    { input: ".", kind: TokenKind.DOT },
    { input: "...", kind: TokenKind.ELLIPSIS },
    { input: ":", kind: TokenKind.COLON },
    { input: "?", kind: TokenKind.QUESTION },
    { input: "=>", kind: TokenKind.FATARROW },
    // Operators
    { input: "+", kind: TokenKind.PLUS },
    { input: "-", kind: TokenKind.MINUS },
    { input: "*", kind: TokenKind.STAR },
    { input: "/", kind: TokenKind.SLASH },
    { input: "%", kind: TokenKind.PERCENT },
    { input: "==", kind: TokenKind.EQ },
    { input: "!=", kind: TokenKind.NEQ },
    { input: "<", kind: TokenKind.LT },
    { input: "<=", kind: TokenKind.LE },
    { input: ">", kind: TokenKind.GT },
    { input: ">=", kind: TokenKind.GE },
    { input: "&&", kind: TokenKind.AND },
    { input: "||", kind: TokenKind.OR },
    { input: "!", kind: TokenKind.BANG },
    { input: "=", kind: TokenKind.ASSIGN },
    // Structural
    { input: "\n", kind: TokenKind.NEWLINE },
    { input: "\r\n", kind: TokenKind.NEWLINE },
  ];

  for (const { input, kind } of cases) {
    // Skip the underscore case — it's a negative test handled below.
    if (input === "_underscore") continue;
    it(`lexes ${JSON.stringify(input)} as ${kind}`, () => {
      const [first] = tokens(input);
      expect(first?.kind).toBe(kind);
      expect(first?.lexeme).toBe(input);
    });
  }

  it("rejects underscore as the start of an identifier (not in UAX #31 ID_Start)", () => {
    // "_" → INVALID (single char), then "underscore" → IDENT.
    const ts = tokens("_underscore");
    expect(ts[0]?.kind).toBe(TokenKind.INVALID);
    expect(ts[0]?.error).toBeDefined();
    expect(ts[1]?.kind).toBe(TokenKind.IDENT);
    expect(ts[1]?.lexeme).toBe("underscore");
  });

  it("appends EOF to every stream", () => {
    const ts = tokens("");
    expect(ts).toHaveLength(1);
    expect(ts[0]?.kind).toBe(TokenKind.EOF);
    expect(ts[0]?.lexeme).toBe("");
  });
});

describe("trivia attachment", () => {
  it("attaches leading whitespace to the next token", () => {
    const [t] = tokens("   foo");
    expect(t?.leadingTrivia).toBe("   ");
    expect(t?.lexeme).toBe("foo");
    expect(t?.trailingTrivia).toBe("");
  });

  it("attaches same-line line comments as trailing trivia", () => {
    const [t] = tokens("foo # trailing\n");
    expect(t?.lexeme).toBe("foo");
    expect(t?.trailingTrivia).toBe(" # trailing");
  });

  it("attaches both # and // line comments", () => {
    const hashT = tokens("foo # c\n")[0]!;
    const slashT = tokens("foo // c\n")[0]!;
    expect(hashT.trailingTrivia).toBe(" # c");
    expect(slashT.trailingTrivia).toBe(" // c");
  });

  it("attaches same-line block comments as trailing trivia", () => {
    const [t] = tokens("foo /* block */ bar");
    // Trailing consumes adjacent same-line whitespace on both sides of the
    // block comment — anything that's neither the previous lexeme nor the
    // next lexeme.
    expect(t?.trailingTrivia).toBe(" /* block */ ");
  });

  it("keeps multi-line block comments out of trailing trivia", () => {
    const ts = tokens("foo\n/* multi\n   line */\nbar");
    const foo = ts.find((t) => t.kind === TokenKind.IDENT && t.lexeme === "foo")!;
    // The block comment crosses a newline, so it cannot attach as trailing
    // trivia of foo. It ends up as leading trivia of whichever token
    // comes after the newline that precedes it — here, the second NEWLINE.
    expect(foo.trailingTrivia).toBe("");
    const joined = ts
      .map((t) => t.leadingTrivia + t.lexeme + t.trailingTrivia)
      .join("");
    expect(joined).toContain("/* multi\n   line */");
  });

  it("preserves leading comments before the first token", () => {
    const [first] = tokens("# file header\nfoo");
    expect(first?.kind).toBe(TokenKind.NEWLINE);
    // The file-header comment attaches to the NEWLINE as leading trivia.
    expect(first?.leadingTrivia).toBe("# file header");
  });
});

describe("newline suppression", () => {
  it("emits NEWLINE tokens at top level", () => {
    const ts = tokens("a\nb");
    const kinds = ts.map((t) => t.kind);
    expect(kinds).toEqual([
      TokenKind.IDENT,
      TokenKind.NEWLINE,
      TokenKind.IDENT,
      TokenKind.EOF,
    ]);
  });

  it("suppresses newlines inside ()", () => {
    const kinds = kindsOnly("f(\n  a\n)");
    expect(kinds).toEqual([
      TokenKind.IDENT,
      TokenKind.LPAREN,
      TokenKind.IDENT,
      TokenKind.RPAREN,
      TokenKind.EOF,
    ]);
  });

  it("suppresses newlines inside []", () => {
    const kinds = kindsOnly("[\n  a\n]");
    expect(kinds).toEqual([
      TokenKind.LBRACK,
      TokenKind.IDENT,
      TokenKind.RBRACK,
      TokenKind.EOF,
    ]);
  });

  it("does NOT suppress newlines inside {} at the lexer level", () => {
    const kinds = kindsOnly("{\n  a\n}");
    expect(kinds).toContain(TokenKind.NEWLINE);
  });

  it("restores newline emission after matching bracket closes", () => {
    const kinds = kindsOnly("[a]\nb");
    expect(kinds).toContain(TokenKind.NEWLINE);
  });
});

describe("strings and templates", () => {
  it("lexes a simple quoted string as OQUOTE + QUOTED_LIT + CQUOTE", () => {
    const ts = tokens('"hi"');
    expect(ts.map((t) => t.kind)).toEqual([
      TokenKind.OQUOTE,
      TokenKind.QUOTED_LIT,
      TokenKind.CQUOTE,
      TokenKind.EOF,
    ]);
    expect(ts[1]?.lexeme).toBe("hi");
  });

  it("lexes an empty quoted string as OQUOTE + CQUOTE", () => {
    const ts = tokens('""');
    expect(ts.map((t) => t.kind)).toEqual([
      TokenKind.OQUOTE,
      TokenKind.CQUOTE,
      TokenKind.EOF,
    ]);
  });

  it("splits a template around interpolations", () => {
    const ts = tokens('"a${b}c"');
    expect(ts.map((t) => t.kind)).toEqual([
      TokenKind.OQUOTE,
      TokenKind.QUOTED_LIT,
      TokenKind.TEMPLATE_INTERP,
      TokenKind.IDENT,
      TokenKind.TEMPLATE_SEQ_END,
      TokenKind.QUOTED_LIT,
      TokenKind.CQUOTE,
      TokenKind.EOF,
    ]);
  });

  it("handles nested braces inside a template interpolation", () => {
    const ts = tokens('"${ { a = 1 }.a }"');
    expect(ts.map((t) => t.kind)).toEqual([
      TokenKind.OQUOTE,
      TokenKind.TEMPLATE_INTERP,
      TokenKind.LBRACE,
      TokenKind.IDENT, // a
      TokenKind.ASSIGN,
      TokenKind.NUMBER,
      TokenKind.RBRACE,
      TokenKind.DOT,
      TokenKind.IDENT, // a
      TokenKind.TEMPLATE_SEQ_END,
      TokenKind.CQUOTE,
      TokenKind.EOF,
    ]);
  });

  it("recognizes TEMPLATE_CONTROL directives (%{...})", () => {
    const ts = tokens('"%{if x}y%{endif}"');
    const kinds = ts.map((t) => t.kind);
    expect(kinds).toContain(TokenKind.TEMPLATE_CONTROL);
    expect(kinds).toContain(TokenKind.TEMPLATE_SEQ_END);
  });

  it("consumes strip markers (${~ ... ~}) as TEMPLATE_STRIP", () => {
    const ts = tokens('"${~ x ~}"');
    const kinds = ts.map((t) => t.kind);
    expect(kinds.filter((k) => k === TokenKind.TEMPLATE_STRIP)).toHaveLength(2);
  });

  it("keeps escape sequences as part of QUOTED_LIT", () => {
    const ts = tokens('"a\\nb"');
    const lit = ts[1]!;
    expect(lit.kind).toBe(TokenKind.QUOTED_LIT);
    expect(lit.lexeme).toBe("a\\nb");
  });

  it("treats $$ and %% as escaped literal $ and %", () => {
    const ts = tokens('"$$ %%"');
    const lit = ts[1]!;
    expect(lit.kind).toBe(TokenKind.QUOTED_LIT);
    expect(lit.lexeme).toBe("$$ %%");
  });
});

describe("heredocs", () => {
  it("emits HEREDOC_BEGIN / QUOTED_LIT / HEREDOC_END for a simple heredoc", () => {
    const src = "x = <<FOO\nline1\nline2\nFOO\n";
    const kinds = kindsOnly(src);
    expect(kinds).toEqual([
      TokenKind.IDENT, // x
      TokenKind.ASSIGN,
      TokenKind.HEREDOC_BEGIN,
      TokenKind.QUOTED_LIT,
      TokenKind.HEREDOC_END,
      TokenKind.NEWLINE,
      TokenKind.EOF,
    ]);
  });

  it("recognizes the <<- indent-strip form", () => {
    const src = "x = <<-FOO\n  line\n  FOO\n";
    const kinds = kindsOnly(src);
    expect(kinds).toContain(TokenKind.HEREDOC_BEGIN);
    expect(kinds).toContain(TokenKind.HEREDOC_END);
  });

  it("supports interpolations inside heredoc bodies", () => {
    const src = "x = <<FOO\nhello ${name}\nFOO\n";
    const kinds = kindsOnly(src);
    expect(kinds).toEqual([
      TokenKind.IDENT,
      TokenKind.ASSIGN,
      TokenKind.HEREDOC_BEGIN,
      TokenKind.QUOTED_LIT,
      TokenKind.TEMPLATE_INTERP,
      TokenKind.IDENT, // name
      TokenKind.TEMPLATE_SEQ_END,
      TokenKind.QUOTED_LIT,
      TokenKind.HEREDOC_END,
      TokenKind.NEWLINE,
      TokenKind.EOF,
    ]);
  });

  it("falls back to two LT tokens when <<... doesn't form a heredoc", () => {
    const kinds = kindsOnly("<< 1");
    // "<<" then " 1" — here the two `<` are each a single LT token.
    expect(kinds[0]).toBe(TokenKind.LT);
    expect(kinds[1]).toBe(TokenKind.LT);
  });
});

describe("error recovery", () => {
  it("emits an INVALID token for an unknown character and continues lexing", () => {
    const ts = tokens("a @ b");
    const invalid = ts.find((t) => t.kind === TokenKind.INVALID);
    expect(invalid).toBeDefined();
    expect(invalid!.lexeme).toBe("@");
    expect(invalid!.error).toMatch(/unexpected/);
    // Lexer continued — we still see the trailing IDENT.
    expect(ts.some((t) => t.kind === TokenKind.IDENT && t.lexeme === "b")).toBe(true);
  });

  it("rejects stray ~ outside of a template sequence", () => {
    const ts = tokens("a ~ b");
    const invalid = ts.find((t) => t.kind === TokenKind.INVALID);
    expect(invalid).toBeDefined();
    expect(invalid!.lexeme).toBe("~");
  });

  it("produces EOF with an error message for unterminated templates", () => {
    const ts = tokens('"abc');
    const last = ts[ts.length - 1]!;
    expect(last.kind).toBe(TokenKind.EOF);
    expect(last.error).toMatch(/unterminated/);
  });

  it("rejects lone & and | as invalid (not && or ||)", () => {
    const amp = tokens("a & b").find((t) => t.kind === TokenKind.INVALID);
    const pipe = tokens("a | b").find((t) => t.kind === TokenKind.INVALID);
    expect(amp?.lexeme).toBe("&");
    expect(pipe?.lexeme).toBe("|");
  });

  it("survives unterminated block comments (consumed to EOF)", () => {
    const ts = tokens("/* unterminated");
    // The comment consumes everything; we should still get an EOF.
    const last = ts[ts.length - 1]!;
    expect(last.kind).toBe(TokenKind.EOF);
  });

  it("handles a trailing-position block comment that never terminates", () => {
    // Exercises skipTrailingTrivia's same-line-block-comment check when the
    // block comment is unterminated and contains no newline: the helper
    // must conclude \"does not end on same line\" and leave the comment to
    // be picked up by skipLeadingTrivia instead.
    const ts = tokens("foo /* unterminated");
    expect(ts[0]?.kind).toBe(TokenKind.IDENT);
    expect(ts[0]?.lexeme).toBe("foo");
    const last = ts[ts.length - 1]!;
    expect(last.kind).toBe(TokenKind.EOF);
  });

  it("absorbs raw newlines into a quoted-string QUOTED_LIT (parser flags the error)", () => {
    const ts = tokens('"abc\nrest');
    expect(ts[0]?.kind).toBe(TokenKind.OQUOTE);
    expect(ts[1]?.kind).toBe(TokenKind.QUOTED_LIT);
    expect(ts[1]?.lexeme).toBe("abc\nrest");
    // Unterminated template — last token is EOF with error.
    const last = ts[ts.length - 1]!;
    expect(last.kind).toBe(TokenKind.EOF);
    expect(last.error).toMatch(/unterminated/);
  });
});

describe("heredoc edge cases", () => {
  it("accepts CRLF after the heredoc opener", () => {
    const ts = tokens("x = <<END\r\nhi\r\nEND\r\n");
    const begin = ts.find((t) => t.kind === TokenKind.HEREDOC_BEGIN);
    expect(begin?.lexeme).toMatch(/^<<END\r\n$/);
  });

  it("rejects << when no newline follows the delimiter identifier", () => {
    // `<<END` with no trailing newline cannot be a heredoc, so the lexer
    // falls back to emitting LT, LT, IDENT separately.
    const kinds = kindsOnly("<<END");
    expect(kinds.slice(0, 3)).toEqual([
      TokenKind.LT,
      TokenKind.LT,
      TokenKind.IDENT,
    ]);
  });

  it("does not match a heredoc-end candidate when the delimiter is followed by garbage", () => {
    const src = "x = <<END\nhi\nENDx\nEND\n";
    // `ENDx` does NOT terminate the heredoc; the real terminator is the
    // later `END` line.
    const ts = tokens(src);
    const end = ts.find((t) => t.kind === TokenKind.HEREDOC_END);
    expect(end?.lexeme).toBe("END");
  });
});

describe("suppressed newlines inside interpolations", () => {
  it("treats newlines as whitespace inside ${...}", () => {
    const ts = tokens('"${\n  foo\n}"');
    const kinds = ts.map((t) => t.kind);
    expect(kinds).not.toContain(TokenKind.NEWLINE);
    expectRejoin('"${\n  foo\n}"');
  });
});

describe("supplementary-plane identifiers", () => {
  it("recognizes CJK Extension B code points (surrogate pairs)", () => {
    // U+20000 is a CJK ideograph in the supplementary plane.
    const src = "\u{20000} = 1\n";
    const ts = tokens(src);
    expect(ts[0]?.kind).toBe(TokenKind.IDENT);
    expect(ts[0]?.lexeme).toBe("\u{20000}");
  });
});

describe("range tracking", () => {
  it("reports 1-based line/column ranges on tokens", () => {
    const ts = tokens("foo\nbar");
    const bar = ts.find((t) => t.kind === TokenKind.IDENT && t.lexeme === "bar");
    expect(bar!.range.start).toEqual({ line: 2, column: 1, offset: 4 });
    expect(bar!.range.end).toEqual({ line: 2, column: 4, offset: 7 });
  });

  it("ranges exclude leading trivia", () => {
    const ts = tokens("   foo");
    const foo = ts[0]!;
    expect(foo.leadingTrivia).toBe("   ");
    expect(foo.range.start.offset).toBe(3);
    expect(foo.range.end.offset).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip fixtures. The property: concatenating
// `leadingTrivia + lexeme + trailingTrivia` for every token reproduces the
// input verbatim. This is the load-bearing correctness check for the lexer
// and the foundation for the lossless Document API in M7.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES: Array<{ name: string; input: string }> = [
  { name: "empty file", input: "" },
  { name: "single attribute", input: "foo = 1\n" },
  { name: "attribute without trailing newline", input: "foo = 1" },
  { name: "multi attributes", input: "a = 1\nb = 2\nc = 3\n" },
  {
    name: "labeled block",
    input: 'resource "aws_s3_bucket" "b" {\n  acl = "private"\n}\n',
  },
  {
    name: "nested blocks",
    input: "module {\n  source = \"./m\"\n  vars {\n    count = 1\n  }\n}\n",
  },
  {
    name: "one-line block",
    input: 'locals "x" { y = 1 }\n',
  },
  {
    name: "tuple literal with trailing comma",
    input: "x = [1, 2, 3,]\n",
  },
  {
    name: "object literal",
    input: "x = { a = 1, b = 2 }\n",
  },
  {
    name: "tuple spanning lines with suppressed newlines",
    input: "x = [\n  1,\n  2,\n  3,\n]\n",
  },
  {
    name: "interpolation in string",
    input: 'greeting = "hello ${name}!"\n',
  },
  {
    name: "nested interpolation",
    input: 'x = "${ { k = 1 }.k }"\n',
  },
  {
    name: "control directive in string",
    input: 'x = "%{if cond}yes%{else}no%{endif}"\n',
  },
  {
    name: "heredoc plain",
    input: "x = <<END\nhello world\nEND\n",
  },
  {
    name: "heredoc strip",
    input: "x = <<-END\n  hello\n  world\n  END\n",
  },
  {
    name: "heredoc with interpolation",
    input: "x = <<END\nhi ${name}\nEND\n",
  },
  {
    name: "line comments",
    input: "# leading\nfoo = 1 # trailing\n// another\nbar = 2\n",
  },
  {
    name: "block comments mid-line and multi-line",
    input: "foo = /* inline */ 1\n/* multi\n   line */\nbar = 2\n",
  },
  {
    name: "CRLF line endings",
    input: "a = 1\r\nb = 2\r\n",
  },
  {
    name: "unicode identifiers",
    input: "αβγ = 1\n中文 = 2\n",
  },
  {
    name: "identifier with dashes",
    input: "foo-bar = 1\n",
  },
  {
    name: "numeric variations",
    input: "a = 0\nb = 1.5\nc = 2e10\nd = 3.14E-2\n",
  },
  {
    name: "operators and expressions",
    input: "x = a + b * c - d / e\ny = !cond && other || third\n",
  },
  {
    name: "comparisons and conditional",
    input: "x = a > b ? c : d\ny = a == b\nz = a != b\n",
  },
  {
    name: "function call with splat arg",
    input: "x = f(a, b, c...)\n",
  },
  {
    name: "traversal with attribute + index + splat",
    input: "x = a.b[0].*.c\n",
  },
  {
    name: "fat arrow in for-expr",
    input: "x = { for k, v in m : k => v if v > 0 }\n",
  },
  {
    name: "mixed whitespace and tabs",
    input: "foo\t=\t1\n\tbar = 2\n",
  },
  {
    name: "strip markers in template",
    input: 'x = "${~ trim ~}"\n',
  },
];

describe("round-trip fixtures", () => {
  it(`exercises at least 20 fixtures (actually ${FIXTURES.length})`, () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  for (const { name, input } of FIXTURES) {
    it(`round-trips: ${name}`, () => {
      expectRejoin(input);
    });
  }

  it("every fixture ends with an EOF token", () => {
    for (const { name, input } of FIXTURES) {
      const ts = tokens(input);
      const last = ts[ts.length - 1]!;
      expect(last.kind, name).toBe(TokenKind.EOF);
    }
  });
});
