import { describe, expect, it } from "vitest";
import HCL, {
  HCLParseError,
  isExpression,
  parse,
  unescapeTemplateLiteral,
} from "../src/index.js";
import type { Expression, Value } from "../src/index.js";

/** Narrower parse helper for tests that want a specific Value shape. */
function parseOK(text: string): Record<string, Value> {
  return parse(text) as Record<string, Value>;
}

function expectExpression(v: Value | undefined): Expression {
  expect(isExpression(v)).toBe(true);
  return v as Expression;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive attributes
// ─────────────────────────────────────────────────────────────────────────────

describe("primitive value collapse", () => {
  it("collapses integer literals to number", () => {
    expect(parseOK("x = 1\n")).toEqual({ x: 1 });
  });
  it("collapses floats and scientific", () => {
    expect(parseOK("x = 1.5\ny = 2e3\n")).toEqual({ x: 1.5, y: 2000 });
  });
  it("collapses booleans and null", () => {
    expect(parseOK("a = true\nb = false\nc = null\n")).toEqual({
      a: true,
      b: false,
      c: null,
    });
  });
  it("collapses plain strings and unescapes \\n etc", () => {
    expect(parseOK('s = "hello\\nworld\\t!"\n')).toEqual({
      s: "hello\nworld\t!",
    });
  });
  it("unescapes \\uNNNN code points", () => {
    expect(parseOK('s = "\\u00e9"\n')).toEqual({ s: "é" });
  });
  it("unescapes \\UNNNNNNNN supplementary code points", () => {
    expect(parseOK('s = "\\U0001F389"\n')).toEqual({ s: "🎉" });
  });
  it("treats $${ and %%{ as literal ${ / %{ in strings", () => {
    expect(parseOK('s = "$${x}"\n')).toEqual({ s: "${x}" });
    expect(parseOK('t = "%%{y}"\n')).toEqual({ t: "%{y}" });
  });
  it("heredocs preserve backslashes literally but still honor $${", () => {
    expect(parseOK("s = <<EOT\nline\\nhere\nEOT\n")).toEqual({
      s: "line\\nhere\n",
    });
    expect(parseOK("s = <<EOT\n$${foo}\nEOT\n")).toEqual({
      s: "${foo}\n",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Collections
// ─────────────────────────────────────────────────────────────────────────────

describe("collection collapse", () => {
  it("collapses literal tuples into JS arrays", () => {
    expect(parseOK("xs = [1, 2, 3]\n")).toEqual({ xs: [1, 2, 3] });
  });
  it("collapses literal objects with identifier keys", () => {
    expect(parseOK("o = { a = 1, b = 2 }\n")).toEqual({
      o: { a: 1, b: 2 },
    });
  });
  it("collapses objects with string keys", () => {
    expect(parseOK('o = { "k" = 1, "l" = 2 }\n')).toEqual({
      o: { k: 1, l: 2 },
    });
  });
  it("collapses nested collections when every leaf is literal", () => {
    expect(
      parseOK("o = { a = [1, 2], b = { c = true } }\n"),
    ).toEqual({
      o: { a: [1, 2], b: { c: true } },
    });
  });

  it("wraps tuples as Expression when any item needs evaluation", () => {
    const v = parseOK("xs = [1, x, 3]\n") as { xs: Value };
    const expr = expectExpression(v.xs);
    expect(expr.kind).toBe("tuple");
    expect(expr.source).toContain("[1, x, 3]");
  });

  it("wraps objects as Expression when any value is non-literal", () => {
    const v = parseOK("o = { a = 1, b = x }\n") as { o: Value };
    expect(expectExpression(v.o).kind).toBe("object");
  });

  it("wraps objects as Expression when a key is computed", () => {
    const v = parseOK("o = { (k) = 1 }\n") as { o: Value };
    expect(expectExpression(v.o).kind).toBe("object");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Expression wrapping for non-collapsing constructs
// ─────────────────────────────────────────────────────────────────────────────

describe("expression wrapping", () => {
  it("wraps variables", () => {
    const e = expectExpression(
      (parseOK("x = y\n") as { x: Value }).x,
    );
    expect(e.kind).toBe("variable");
    expect(e.source).toBe("y");
  });

  it("wraps function calls", () => {
    const e = expectExpression(
      (parseOK("x = f(1, 2)\n") as { x: Value }).x,
    );
    expect(e.kind).toBe("function-call");
    expect(e.source).toBe("f(1, 2)");
  });

  it("wraps binary operators", () => {
    const e = expectExpression(
      (parseOK("x = 1 + 2\n") as { x: Value }).x,
    );
    expect(e.kind).toBe("binary");
  });

  it("wraps conditionals", () => {
    const e = expectExpression(
      (parseOK("x = a > b ? c : d\n") as { x: Value }).x,
    );
    expect(e.kind).toBe("conditional");
  });

  it("wraps unary operators", () => {
    const e = expectExpression((parseOK("x = -a\n") as { x: Value }).x);
    expect(e.kind).toBe("unary");
  });

  it("wraps traversals", () => {
    const e = expectExpression(
      (parseOK("x = a.b.c\n") as { x: Value }).x,
    );
    expect(e.kind).toBe("traversal");
  });

  it("wraps splats", () => {
    const e = expectExpression(
      (parseOK("x = a[*].b\n") as { x: Value }).x,
    );
    expect(e.kind).toBe("splat");
  });

  it("wraps for expressions", () => {
    const e = expectExpression(
      (parseOK("x = [for v in xs : v]\n") as { x: Value }).x,
    );
    expect(e.kind).toBe("for");
  });

  it("wraps parens (round-trip preservation)", () => {
    const e = expectExpression(
      (parseOK("x = (1 + 2)\n") as { x: Value }).x,
    );
    expect(e.kind).toBe("parens");
  });

  it("wraps templates with interpolations as Expression", () => {
    const e = expectExpression(
      (parseOK('x = "hi ${name}"\n') as { x: Value }).x,
    );
    expect(e.kind).toBe("template");
    expect(e.source).toBe('"hi ${name}"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block grouping matrix: 0, 1, 2, 3 labels, unique + duplicate
// ─────────────────────────────────────────────────────────────────────────────

describe("block grouping — 0 labels", () => {
  it("single unlabeled block nests under its type", () => {
    expect(parseOK("block {}\n")).toEqual({ block: {} });
  });
  it("two unlabeled blocks of the same type collect into an array", () => {
    expect(parseOK("block {\n a = 1\n}\nblock {\n  a = 2\n}\n")).toEqual({
      block: [{ a: 1 }, { a: 2 }],
    });
  });
  it("unlabeled blocks of different types become sibling keys", () => {
    expect(parseOK("a {}\nb {}\n")).toEqual({ a: {}, b: {} });
  });
});

describe("block grouping — 1 label", () => {
  it("single-labeled block nests type → label", () => {
    expect(parseOK('module "m" {\n  source = "./m"\n}\n')).toEqual({
      module: { m: { source: "./m" } },
    });
  });
  it("different labels under same type become sibling keys", () => {
    expect(
      parseOK('module "a" {}\nmodule "b" {}\n'),
    ).toEqual({
      module: { a: {}, b: {} },
    });
  });
  it("duplicate (type+label) collects into array at the leaf", () => {
    expect(
      parseOK('module "m" {\n  x = 1\n}\nmodule "m" {\n  x = 2\n}\n'),
    ).toEqual({
      module: { m: [{ x: 1 }, { x: 2 }] },
    });
  });
});

describe("block grouping — 2 labels (Terraform resource shape)", () => {
  it("two different (type+label1+label2) become siblings", () => {
    const v = parseOK(
      'resource "aws_s3_bucket" "a" {}\nresource "aws_s3_bucket" "b" {}\n',
    );
    expect(v).toEqual({
      resource: { aws_s3_bucket: { a: {}, b: {} } },
    });
  });

  it("two different types under same block keyword", () => {
    const v = parseOK(
      'resource "aws_s3_bucket" "a" {}\nresource "aws_instance" "a" {}\n',
    );
    expect(v).toEqual({
      resource: { aws_s3_bucket: { a: {} }, aws_instance: { a: {} } },
    });
  });

  it("duplicate leaf (same type+label1+label2) collects into array", () => {
    const v = parseOK(
      'resource "t" "n" {\n  x = 1\n}\nresource "t" "n" {\n  x = 2\n}\n',
    );
    expect(v).toEqual({
      resource: { t: { n: [{ x: 1 }, { x: 2 }] } },
    });
  });
});

describe("block grouping — 3 labels", () => {
  it("three-label blocks nest fully", () => {
    const v = parseOK("triple one two three {\n  x = 1\n}\n");
    expect(v).toEqual({
      triple: { one: { two: { three: { x: 1 } } } },
    });
  });

  it("duplicate three-label leaves collect into array", () => {
    const v = parseOK(
      "t a b c {\n  x = 1\n}\nt a b c {\n  x = 2\n}\n",
    );
    expect(v).toEqual({ t: { a: { b: { c: [{ x: 1 }, { x: 2 }] } } } });
  });
});

describe("block grouping — mixed unique/duplicate", () => {
  it("three duplicates collect into a 3-element array", () => {
    const v = parseOK(
      'r "t" "n" { x = 1 }\nr "t" "n" { x = 2 }\nr "t" "n" { x = 3 }\n',
    );
    expect(v).toEqual({
      r: { t: { n: [{ x: 1 }, { x: 2 }, { x: 3 }] } },
    });
  });

  it("some unique, some duplicate at the same type prefix", () => {
    const v = parseOK(
      'r "t" "n1" { x = 1 }\nr "t" "n1" { x = 2 }\nr "t" "n2" { x = 3 }\n',
    );
    expect(v).toEqual({
      r: { t: { n1: [{ x: 1 }, { x: 2 }], n2: { x: 3 } } },
    });
  });
});

describe("block body mixing", () => {
  it("attributes and blocks coexist in the same body", () => {
    const v = parseOK(
      'resource "t" "n" {\n  name = "demo"\n  lifecycle {\n    create_before_destroy = true\n  }\n}\n',
    );
    expect(v).toEqual({
      resource: {
        t: {
          n: {
            name: "demo",
            lifecycle: { create_before_destroy: true },
          },
        },
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error + option surface
// ─────────────────────────────────────────────────────────────────────────────

describe("HCL.parse options", () => {
  it("uses the provided filename in error messages", () => {
    try {
      parse("oops\n", { filename: "main.tf" });
    } catch (e) {
      expect(e).toBeInstanceOf(HCLParseError);
      expect((e as HCLParseError).filename).toBe("main.tf");
    }
  });

  it("throws the first error by default (bail: true)", () => {
    expect(() => parse("oops\n")).toThrow(HCLParseError);
  });

  it("with bail: false, throws an aggregate HCLParseError with errors[]", () => {
    try {
      parse("oops1\noops2\n", { bail: false });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HCLParseError);
      const err = e as HCLParseError;
      expect(err.errors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("accepts an empty file", () => {
    expect(parse("")).toEqual({});
  });

  it("is available via the default HCL export", () => {
    expect(HCL.parse("a = 1\n")).toEqual({ a: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unescape helper (direct)
// ─────────────────────────────────────────────────────────────────────────────

describe("unescapeTemplateLiteral (exported helper)", () => {
  it("unescapes quoted-string sequences", () => {
    expect(unescapeTemplateLiteral("a\\nb\\tc\\\"d\\\\e", false)).toBe(
      'a\nb\tc"d\\e',
    );
  });
  it("leaves backslashes alone for heredocs", () => {
    expect(unescapeTemplateLiteral("a\\nb", true)).toBe("a\\nb");
  });
  it("applies $${/%%{ escapes in both modes", () => {
    expect(unescapeTemplateLiteral("$${x}", false)).toBe("${x}");
    expect(unescapeTemplateLiteral("%%{y}", true)).toBe("%{y}");
  });
  it("passes unknown backslash escapes through untouched", () => {
    expect(unescapeTemplateLiteral("\\q", false)).toBe("\\q");
  });
});
