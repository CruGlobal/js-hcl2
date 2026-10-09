import { describe, expect, it } from "vitest";
import { lex } from "../../src/lexer/lexer.js";
import { TokenKind } from "../../src/lexer/token.js";
import type { Token } from "../../src/lexer/token.js";
import { parse, parseExpr } from "../../src/parser/parser.js";
import { parse as parseValue } from "../../src/index.js";
import { print } from "../../src/parser/print.js";
import { SourceFile } from "../../src/source.js";
import type { ExprNode } from "../../src/parser/nodes.js";

function expectNoErrors(text: string): ExprNode {
  const r = parseExpr(text, { bail: false });
  expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  return r.expr;
}

/** Flatten a token stream to a compact [kind, lexeme] list (ignoring trivia). */
function tokenSig(text: string): Array<[TokenKind, string]> {
  return lex(new SourceFile(text))
    .filter((t: Token) => t.kind !== TokenKind.EOF)
    .map((t: Token) => [t.kind, t.lexeme] as [TokenKind, string]);
}

function expectRoundTripTokens(input: string): void {
  const expr = expectNoErrors(input);
  const printed = print(expr);
  expect(tokenSig(printed)).toEqual(tokenSig(input));
}

// ─────────────────────────────────────────────────────────────────────────────
// Literals + Variables
// ─────────────────────────────────────────────────────────────────────────────

describe("literals", () => {
  it("parses integer numbers", () => {
    const expr = expectNoErrors("42");
    expect(expr.kind).toBe("Literal");
    if (expr.kind === "Literal") {
      expect(expr.valueType).toBe("number");
      expect(expr.value).toBe(42);
    }
  });

  it("parses fractional numbers", () => {
    const expr = expectNoErrors("3.14");
    expect(expr.kind).toBe("Literal");
    if (expr.kind === "Literal") expect(expr.value).toBe(3.14);
  });

  it("parses scientific notation", () => {
    const expr = expectNoErrors("1.5e3");
    if (expr.kind === "Literal") expect(expr.value).toBe(1500);
  });

  it("parses true / false / null", () => {
    for (const [src, val] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      const expr = expectNoErrors(src);
      expect(expr.kind).toBe("Literal");
      if (expr.kind === "Literal") expect(expr.value).toBe(val);
    }
  });
});

describe("variables", () => {
  it("parses a bare identifier as a Variable", () => {
    const expr = expectNoErrors("foo");
    expect(expr.kind).toBe("Variable");
    if (expr.kind === "Variable") expect(expr.name).toBe("foo");
  });

  it("parses identifiers with dashes", () => {
    const expr = expectNoErrors("my-var");
    if (expr.kind === "Variable") expect(expr.name).toBe("my-var");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Operators and precedence
// ─────────────────────────────────────────────────────────────────────────────

describe("operator precedence", () => {
  it("* binds tighter than +", () => {
    // 1 + 2 * 3 should parse as 1 + (2 * 3)
    const expr = expectNoErrors("1 + 2 * 3");
    expect(expr.kind).toBe("BinaryOp");
    if (expr.kind === "BinaryOp") {
      expect(expr.op).toBe("+");
      expect(expr.right.kind).toBe("BinaryOp");
      if (expr.right.kind === "BinaryOp") expect(expr.right.op).toBe("*");
    }
  });

  it("&& binds tighter than ||", () => {
    // a || b && c should parse as a || (b && c)
    const expr = expectNoErrors("a || b && c");
    if (expr.kind === "BinaryOp") {
      expect(expr.op).toBe("||");
      expect(expr.right.kind).toBe("BinaryOp");
      if (expr.right.kind === "BinaryOp") expect(expr.right.op).toBe("&&");
    }
  });

  it("== binds tighter than &&", () => {
    // a && b == c should parse as a && (b == c)
    const expr = expectNoErrors("a && b == c");
    if (expr.kind === "BinaryOp") {
      expect(expr.op).toBe("&&");
      expect(expr.right.kind).toBe("BinaryOp");
      if (expr.right.kind === "BinaryOp") expect(expr.right.op).toBe("==");
    }
  });

  it("comparison binds tighter than ==", () => {
    // a == b < c should parse as a == (b < c)
    const expr = expectNoErrors("a == b < c");
    if (expr.kind === "BinaryOp") {
      expect(expr.op).toBe("==");
      expect(expr.right.kind).toBe("BinaryOp");
      if (expr.right.kind === "BinaryOp") expect(expr.right.op).toBe("<");
    }
  });

  it("binary operators are left-associative", () => {
    // a - b - c should parse as (a - b) - c
    const expr = expectNoErrors("a - b - c");
    if (expr.kind === "BinaryOp") {
      expect(expr.op).toBe("-");
      expect(expr.left.kind).toBe("BinaryOp");
      if (expr.left.kind === "BinaryOp") expect(expr.left.op).toBe("-");
      expect(expr.right.kind).toBe("Variable");
    }
  });

  it("conditional is right-associative", () => {
    // a ? b : c ? d : e should parse as a ? b : (c ? d : e)
    const expr = expectNoErrors("a ? b : c ? d : e");
    if (expr.kind === "Conditional") {
      expect(expr.else_.kind).toBe("Conditional");
    }
  });

  it("does not recognize ** as an operator (HCL has no exponent)", () => {
    // -x ** 2: `**` is not an operator in HCL; parses as -x then *, then *2.
    // The second * would need a non-empty left operand; parser will error.
    const r = parseExpr("-x ** 2", { bail: false });
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe("unary operators", () => {
  it("parses negation", () => {
    const expr = expectNoErrors("-x");
    expect(expr.kind).toBe("UnaryOp");
    if (expr.kind === "UnaryOp") expect(expr.op).toBe("-");
  });

  it("parses logical NOT", () => {
    const expr = expectNoErrors("!cond");
    if (expr.kind === "UnaryOp") expect(expr.op).toBe("!");
  });

  it("supports stacked unary ops (right-associative)", () => {
    const expr = expectNoErrors("!!x");
    expect(expr.kind).toBe("UnaryOp");
    if (expr.kind === "UnaryOp") {
      expect(expr.operand.kind).toBe("UnaryOp");
    }
  });

  it("binds tighter than binary ops", () => {
    // -a + b should parse as (-a) + b
    const expr = expectNoErrors("-a + b");
    if (expr.kind === "BinaryOp") {
      expect(expr.op).toBe("+");
      expect(expr.left.kind).toBe("UnaryOp");
    }
  });
});

describe("parens", () => {
  it("parses (expr)", () => {
    const expr = expectNoErrors("(1 + 2)");
    expect(expr.kind).toBe("Parens");
  });

  it("overrides default precedence", () => {
    // (1 + 2) * 3 → the parens preserve the subtree even at print time
    const expr = expectNoErrors("(1 + 2) * 3");
    if (expr.kind === "BinaryOp") {
      expect(expr.op).toBe("*");
      expect(expr.left.kind).toBe("Parens");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conditional
// ─────────────────────────────────────────────────────────────────────────────

describe("conditional", () => {
  it("parses cond ? then : else", () => {
    const expr = expectNoErrors("a > b ? c : d");
    expect(expr.kind).toBe("Conditional");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Postfix: traversal, indexing, splats
// ─────────────────────────────────────────────────────────────────────────────

describe("traversal", () => {
  it("parses .attr chains", () => {
    const expr = expectNoErrors("a.b.c");
    expect(expr.kind).toBe("Traversal");
    if (expr.kind === "Traversal") {
      expect(expr.steps).toHaveLength(2);
      expect(expr.steps[0]!.kind).toBe("GetAttr");
    }
  });

  it("parses [expr] indexing", () => {
    const expr = expectNoErrors("a[0]");
    if (expr.kind === "Traversal") {
      expect(expr.steps[0]!.kind).toBe("Index");
    }
  });

  it("parses mixed . and [] chains", () => {
    const expr = expectNoErrors("a.b[0].c[i]");
    if (expr.kind === "Traversal") expect(expr.steps).toHaveLength(4);
  });

  it("parses legacy .digit+ indexing as a GetAttr step", () => {
    // `a.0` is a legacy form; the parser keeps the numeric lexeme intact
    // for round-trip, with a GetAttr step whose name is "0".
    const expr = expectNoErrors("a.0");
    if (expr.kind === "Traversal") {
      expect(expr.steps[0]!.kind).toBe("GetAttr");
      if (expr.steps[0]!.kind === "GetAttr")
        expect(expr.steps[0]!.name).toBe("0");
    }
  });
});

describe("splats", () => {
  it("parses attribute splats", () => {
    const expr = expectNoErrors("a.*.b");
    expect(expr.kind).toBe("Splat");
    if (expr.kind === "Splat") {
      expect(expr.style).toBe("attr");
      expect(expr.each).toHaveLength(1);
    }
  });

  it("parses full splats with [*]", () => {
    const expr = expectNoErrors("a[*].b[0]");
    expect(expr.kind).toBe("Splat");
    if (expr.kind === "Splat") {
      expect(expr.style).toBe("full");
      expect(expr.each).toHaveLength(2);
    }
  });

  it("attr-splat with no trailing chain still parses", () => {
    const expr = expectNoErrors("a.*");
    expect(expr.kind).toBe("Splat");
    if (expr.kind === "Splat") expect(expr.each).toEqual([]);
  });
});

describe("splat steps", () => {
  // Accept/reject decisions and node shapes match hashicorp/hcl v2.24.0.
  // `.*` takes attribute names only, so an index after it applies to the
  // splat's result. `[*]` runs every later step on each element, later
  // splats included: `x[*].y[*].z` is one splat over `x` whose element
  // chain is `.y[*].z`. `each` holds the plain steps right after `[*]`
  // and `inner` the rest, built on a SplatItem (written `@` below).
  function errorsIn(input: string) {
    return parse(new SourceFile(input), { bail: false }).errors;
  }

  /** A compact picture of an expression's splat / traversal structure. */
  function shape(e: ExprNode): string {
    const step = (s: { kind: string; name?: string }) =>
      s.kind === "GetAttr" ? `.${s.name}` : "[i]";
    if (e.kind === "Splat") {
      const inner = e.inner ? `{${shape(e.inner)}}` : "";
      return `${e.style}(${shape(e.source)})<${e.each.map(step).join("")}>${inner}`;
    }
    if (e.kind === "SplatItem") return "@";
    if (e.kind === "Traversal") return `${shape(e.source)}${e.steps.map(step).join("")}`;
    if (e.kind === "Variable") return e.name;
    return e.kind;
  }

  it.each([
    ["'=' after [*].", "a = x[*].=\n", 1, 10],
    ["'-' after [*].", "a = x[*].-\n", 1, 10],
    ["'}' after [*].", "a = x[*].}\n", 1, 10],
    ["'?' after .*.", "a = x.*.?\n", 1, 9],
    ["a line break after [*].", "a = x[*].\n", 1, 10],
    ["a line break after .*.", "a = x.*.\n", 1, 9],
    ["the end of the file after [*].", "a = x[*].", 1, 10],
    ["the end of the file after .*.", "a = x.*.", 1, 9],
  ])("rejects %s: invalid attribute name", (_ctx, input, line, column) => {
    const errors = errorsIn(input);
    expect(errors[0]!.message).toMatch(/^invalid attribute name/);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
    expect(print(parse(new SourceFile(input), { bail: false }).body)).toBe(input);
  });

  it.each([
    ["x.*.*", "a = x.*.*\n", 1, 9],
    ["x.*.y.*", "a = x.*.y.*\n", 1, 11],
    ["x[*].*.*", "a = x[*].*.*\n", 1, 12],
  ])("rejects a splat inside an attribute-only splat: %s", (_ctx, input, line, column) => {
    const errors = errorsIn(input);
    expect(errors[0]!.message).toMatch(/^nested splat expression not allowed/);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
  });

  it.each([
    ["x[*].y[*].z", "full(x)<.y>{full(@)<.z>}"],
    ["x[*][*]", "full(x)<>{full(@)<>}"],
    ["x[*].y[0][*]", "full(x)<.y[i]>{full(@)<>}"],
    ["x[*].y[*].z[*].w", "full(x)<.y>{full(@)<.z>{full(@)<.w>}}"],
    ["x.*[*]", "full(attr(x)<>)<>"],
    ["x.*.y[*]", "full(attr(x)<.y>)<>"],
    ["x[*].*", "full(x)<>{attr(@)<>}"],
    ["x[*].*[*]", "full(x)<>{full(attr(@)<>)<>}"],
    ["x[*].y.*.z", "full(x)<.y>{attr(@)<.z>}"],
    ["x[*].y.*.z[0]", "full(x)<.y>{attr(@)<.z>[i]}"],
    ["x.*.y[0]", "attr(x)<.y>[i]"],
    ["x.*.y[0].*", "attr(attr(x)<.y>[i])<>"],
    ["x.*[0].y", "attr(x)<>[i].y"],
    ["x[*].y[0]", "full(x)<.y[i]>"],
    ["x[*].0", "full(x)<.0>"],
    ["x.*.0", "attr(x)<.0>"],
    ["x.*.y.0.z", "attr(x)<.y.0.z>"],
  ])("accepts %s", (input, expected) => {
    expect(shape(expectNoErrors(input))).toBe(expected);
    expectRoundTripTokens(input);
  });

  it("gives a nested splat's element a zero-width SplatItem and the outer splat its full range", () => {
    const expr = expectNoErrors("x[*].y[*].z");
    if (expr.kind !== "Splat" || expr.inner === null) throw new Error("expected a nested splat");
    expect(expr.source.kind).toBe("Variable");
    expect([expr.range.start.offset, expr.range.end.offset]).toEqual([0, 11]);
    const inner = expr.inner;
    if (inner.kind !== "Splat") throw new Error("expected a splat");
    expect(inner.source.kind).toBe("SplatItem");
    expect(inner.source.parts).toEqual([]);
    expect([inner.source.range.start.offset, inner.source.range.end.offset]).toEqual([6, 6]);
    expect(print(expr)).toBe("x[*].y[*].z");
  });

  it.each([
    ["x[*\\n]", "a = x[*\n]\n", /^missing close bracket on splat index/],
    ["x[*# c\\n]", "a = x[*# c\n]\n", /^missing close bracket on splat index/],
    ["x[*].y[*\\n].z", "a = x[*].y[*\n].z\n", /^missing close bracket on splat index/],
    ["x[*\\n] in an object", "a = {k = x[*\n]}\n", /^missing close bracket on splat index/],
    ["x[\\n*]", "a = x[\n*]\n", /^expected expression/],
    ["x[*].y[\\n*].z", "a = x[*].y[\n*].z\n", /^expected expression/],
  ])("rejects a line break inside [*] where line breaks count: %s", (_ctx, input, message) => {
    const errors = errorsIn(input);
    expect(errors[0]!.message).toMatch(message);
    expect(print(parse(new SourceFile(input), { bail: false }).body)).toBe(input);
  });

  it.each([
    ["inside a list", "a = [x[\n*]]\n"],
    ["inside parentheses", "a = (x[*\n])\n"],
    ["inside ${ }", 'a = "${x[*\n]}"\n'],
    ["inside a list for", "a = [for v in x : v[*\n]]\n"],
    ["inside an object for", "a = {for k, v in x : k => v[*\n]}\n"],
    ["with spaces", "a = x[ * ]\n"],
    ["with a /* */ comment", "a = x[/* c */*]\n"],
  ])("accepts [*] %s", (_ctx, input) => {
    expect(errorsIn(input)).toEqual([]);
  });

  it("leaves inner null for a splat with no later splat", () => {
    for (const input of ["x[*].y", "x.*.y", "x[*]"]) {
      const expr = expectNoErrors(input);
      expect(expr.kind === "Splat" && expr.inner).toBe(null);
    }
  });

  it("reports the outer splat's kind through parse()", () => {
    const value = parseValue("a = x[*].y[*].z\n") as unknown as { a: { kind: string; ast: ExprNode } };
    expect(value.a.kind).toBe("splat");
    expect(value.a.ast.kind === "Splat" && value.a.ast.source.kind).toBe("Variable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Function calls
// ─────────────────────────────────────────────────────────────────────────────

describe("function calls", () => {
  it("parses no-arg calls", () => {
    const expr = expectNoErrors("f()");
    expect(expr.kind).toBe("Call");
    if (expr.kind === "Call") {
      expect(expr.name).toBe("f");
      expect(expr.args).toHaveLength(0);
    }
  });

  it("parses calls with multiple args", () => {
    const expr = expectNoErrors("f(1, 2, 3)");
    if (expr.kind === "Call") expect(expr.args).toHaveLength(3);
  });

  it("parses the trailing ... expansion", () => {
    const expr = expectNoErrors("f(a, b, c...)");
    if (expr.kind === "Call") {
      expect(expr.expandFinal).toBe(true);
      expect(expr.args).toHaveLength(3);
    }
  });

  it("allows calls as the base of a traversal", () => {
    const expr = expectNoErrors("f(x).y");
    expect(expr.kind).toBe("Traversal");
    if (expr.kind === "Traversal") {
      expect(expr.source.kind).toBe("Call");
    }
  });
});

describe("provider-defined functions", () => {
  it("parses provider::ns::fn(...) as one call named by every segment", () => {
    const text = 'provider::aws::arn_parse("x")';
    const expr = expectNoErrors(text);
    expect(expr.kind).toBe("Call");
    if (expr.kind === "Call") {
      expect(expr.name).toBe("provider::aws::arn_parse");
      expect(expr.nameToken.lexeme).toBe("provider");
      expect(expr.args).toHaveLength(1);
      expect(expr.range.start.offset).toBe(0);
      expect(expr.range.end.offset).toBe(text.length);
    }
    expect(print(expr)).toBe(text);
  });

  it.each([
    ["two segments", "core::max(1, 2)", "core::max"],
    ["four segments", "provider::a::b::c(1)", "provider::a::b::c"],
    ["spaces around ::", "provider :: aws :: arn_parse(x)", "provider::aws::arn_parse"],
    ["a space before (", "provider::aws::arn_parse (x)", "provider::aws::arn_parse"],
    ["keywords as segments", "provider::for::if(1)", "provider::for::if"],
    ["a keyword as the first segment", "null::f()", "null::f"],
    ["an expanded final argument", "provider::a::b(xs...)", "provider::a::b"],
  ])("parses a call with %s", (_ctx, text, name) => {
    const expr = expectNoErrors(text);
    expect(expr.kind).toBe("Call");
    if (expr.kind === "Call") expect(expr.name).toBe(name);
    expect(print(expr)).toBe(text);
  });

  it("parses a keyword followed by ( as a call, as HCL does", () => {
    const expr = expectNoErrors("true(1)");
    expect(expr.kind).toBe("Call");
    if (expr.kind === "Call") expect(expr.name).toBe("true");
  });

  it("allows a provider function as the base of a traversal", () => {
    const expr = expectNoErrors("provider::aws::arn_parse(x).account_id");
    expect(expr.kind).toBe("Traversal");
    if (expr.kind === "Traversal") expect(expr.source.kind).toBe("Call");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Collections + for expressions
// ─────────────────────────────────────────────────────────────────────────────

describe("tuple constructor", () => {
  it("parses an empty tuple", () => {
    const expr = expectNoErrors("[]");
    expect(expr.kind).toBe("Tuple");
    if (expr.kind === "Tuple") expect(expr.items).toHaveLength(0);
  });

  it("parses tuples of literals", () => {
    const expr = expectNoErrors("[1, 2, 3]");
    if (expr.kind === "Tuple") expect(expr.items).toHaveLength(3);
  });

  it("allows trailing comma", () => {
    const expr = expectNoErrors("[1, 2, 3,]");
    if (expr.kind === "Tuple") expect(expr.items).toHaveLength(3);
  });
});

describe("object constructor", () => {
  it("parses an empty object", () => {
    const expr = expectNoErrors("{}");
    expect(expr.kind).toBe("Object");
    if (expr.kind === "Object") expect(expr.items).toHaveLength(0);
  });

  it("parses comma-separated object items", () => {
    const expr = expectNoErrors("{a = 1, b = 2}");
    if (expr.kind === "Object") expect(expr.items).toHaveLength(2);
  });

  it("parses newline-separated object items", () => {
    const expr = expectNoErrors("{\n  a = 1\n  b = 2\n}");
    if (expr.kind === "Object") expect(expr.items).toHaveLength(2);
  });

  it("accepts colon as item separator", () => {
    const expr = expectNoErrors('{"k": "v"}');
    if (expr.kind === "Object") {
      expect(expr.items[0]!.separatorToken.lexeme).toBe(":");
    }
  });
});

describe("for expressions", () => {
  it("parses tuple-for with if clause", () => {
    const expr = expectNoErrors("[for x in xs : x * 2 if x > 0]");
    expect(expr.kind).toBe("For");
    if (expr.kind === "For") {
      expect(expr.isObject).toBe(false);
      expect(expr.keyVar).toBe(null);
      expect(expr.valueVar).toBe("x");
      expect(expr.cond).not.toBe(null);
    }
  });

  it("parses object-for with k,v and => and grouping", () => {
    const expr = expectNoErrors("{for k, v in m : k => v... }");
    if (expr.kind === "For") {
      expect(expr.isObject).toBe(true);
      expect(expr.keyVar).toBe("k");
      expect(expr.valueVar).toBe("v");
      expect(expr.group).toBe(true);
    }
  });

  // Inside `{ }` the lexer keeps newlines (they separate object items), so
  // a multi-line object for-expression — the shape `terraform fmt` emits —
  // surfaces NEWLINE tokens before `for` and between the grammar elements.
  // These regressed as "expected '=' or ':' in object item" before the
  // parser learned to skip them (tuple-for never hit this: the lexer
  // suppresses newlines inside `[ ]`).
  it("parses a multi-line object-for with the body split across lines", () => {
    const src = "{\n  for index, app in items :\n  app => index\n}";
    const expr = expectNoErrors(src);
    expect(expr.kind).toBe("For");
    if (expr.kind === "For") {
      expect(expr.isObject).toBe(true);
      expect(expr.keyVar).toBe("index");
      expect(expr.valueVar).toBe("app");
    }
  });

  it("round-trips a multi-line object-for byte-for-byte", () => {
    const src = "{\n  for k, v in m :\n  k => upper(v)\n  if v != \"\"\n}";
    const expr = expectNoErrors(src);
    expect(print(expr)).toBe(src);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

describe("templates", () => {
  it("parses a plain quoted string as a Template", () => {
    const expr = expectNoErrors('"hello"');
    expect(expr.kind).toBe("Template");
    if (expr.kind === "Template") {
      expect(expr.isHeredoc).toBe(false);
      expect(expr.templateParts).toHaveLength(1);
      expect(expr.templateParts[0]!.kind).toBe("StringPart");
    }
  });

  it("parses a string with one interpolation", () => {
    const expr = expectNoErrors('"hello ${name}"');
    if (expr.kind === "Template") {
      expect(expr.templateParts.map((p) => p.kind)).toEqual([
        "StringPart",
        "Interpolation",
      ]);
    }
  });

  it("captures strip markers on an interpolation", () => {
    const expr = expectNoErrors('"${~ x ~}"');
    if (expr.kind === "Template") {
      const interp = expr.templateParts[0];
      expect(interp?.kind).toBe("Interpolation");
      if (interp?.kind === "Interpolation") {
        expect(interp.stripLeft).toBe(true);
        expect(interp.stripRight).toBe(true);
      }
    }
  });

  it("parses template if/else/endif directives", () => {
    const expr = expectNoErrors('"%{if cond}yes%{else}no%{endif}"');
    if (expr.kind === "Template") {
      const dir = expr.templateParts[0];
      expect(dir?.kind).toBe("IfDirective");
      if (dir?.kind === "IfDirective") {
        expect(dir.thenParts).toHaveLength(1);
        expect(dir.elseParts).toHaveLength(1);
      }
    }
  });

  it("parses template for/endfor directives", () => {
    const expr = expectNoErrors(
      '"%{for k, v in m}${k}=${v}%{endfor}"',
    );
    if (expr.kind === "Template") {
      const dir = expr.templateParts[0];
      expect(dir?.kind).toBe("ForDirective");
      if (dir?.kind === "ForDirective") {
        expect(dir.keyVar).toBe("k");
        expect(dir.valueVar).toBe("v");
      }
    }
  });
});

describe("heredocs", () => {
  it("parses a plain heredoc into a Template node", () => {
    const expr = expectNoErrors("<<EOT\nhello\nEOT\n");
    expect(expr.kind).toBe("Template");
    if (expr.kind === "Template") {
      expect(expr.isHeredoc).toBe(true);
      // Body is represented as a single string part containing "hello\n".
      expect(expr.templateParts[0]!.kind).toBe("StringPart");
    }
  });

  it("parses an interpolation inside a heredoc", () => {
    const expr = expectNoErrors("<<EOT\nhi ${name}\nEOT\n");
    if (expr.kind === "Template") {
      expect(expr.templateParts.some((p) => p.kind === "Interpolation")).toBe(
        true,
      );
    }
  });

  it("recognizes the <<- strip form on the opening token", () => {
    const expr = expectNoErrors("<<-EOT\n  hi\n  EOT\n");
    if (expr.kind === "Template") {
      expect(expr.openToken.lexeme.startsWith("<<-")).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property test: lex(text) == lex(print(parseExpr(text)))
// ─────────────────────────────────────────────────────────────────────────────

const PROPERTY_CASES: string[] = [
  "1",
  "1.5",
  "true",
  "null",
  "foo",
  "foo-bar",
  "1 + 2",
  "a + b * c - d",
  "a || b && c",
  "a == b != c",
  "-a + b",
  "!!cond",
  "a ? b : c",
  "a ? b : c ? d : e",
  "a.b.c",
  "a[0]",
  "a.b[i].c",
  "a.*.b",
  "a[*].b[0]",
  "a.0",
  "f()",
  "f(1, 2, 3)",
  "f(a, b, c...)",
  "f(x).y",
  "[]",
  "[1, 2, 3]",
  "[1, 2, 3,]",
  "{}",
  "{a = 1}",
  "{a = 1, b = 2}",
  "{\n  a = 1\n  b = 2\n}",
  '{"k": "v"}',
  "[for x in xs : x * 2]",
  "[for x in xs : x * 2 if x > 0]",
  "{for k, v in m : k => v}",
  "{for k, v in m : k => v...}",
  // Multi-line object for-expressions: newline after `{`, after `:`, and
  // before `}` must round-trip through `parts`.
  "{\n  for k, v in m : k => v\n}",
  "{\n  for k, v in m :\n  k => v\n}",
  "{\n  for k, v in m :\n  k => v\n  if v != null\n}",
  '"hello"',
  '"hello ${name}"',
  '"a${b}c${d}e"',
  '"${~ x ~}"',
  '"%{if c}y%{else}n%{endif}"',
  '"%{for k,v in m}${k}=${v}%{endfor}"',
  // Heredoc terminators may be followed by newline or EOF; these cases
  // terminate at EOF so the entire text belongs to the expression.
  "<<EOT\nhello\nEOT",
  "<<-EOT\n  hi\n  EOT",
  "<<EOT\nhi ${name}\nEOT",
  "(1 + 2) * 3",
  "-x.y.z",
  "a.b + c.d",
  "a[b.c]",
];

describe("property: lex(text) == lex(print(parseExpr(text)))", () => {
  for (const input of PROPERTY_CASES) {
    it(`round-trip tokens: ${JSON.stringify(input)}`, () => {
      expectRoundTripTokens(input);
    });
  }
});
