import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { print } from "../../src/parser/print.js";
import { SourceFile } from "../../src/source.js";

function parseOK(input: string) {
  const source = new SourceFile(input);
  const result = parse(source, { bail: false });
  expect(result.errors, `errors on input ${JSON.stringify(input)}`).toEqual([]);
  return { ...result, source };
}

function expectRoundTrip(input: string) {
  const { body } = parseOK(input);
  expect(print(body)).toBe(input);
}

describe("empty + trivial bodies", () => {
  it("parses an empty file into an empty body", () => {
    const { body } = parseOK("");
    expect(body.kind).toBe("Body");
    expect(body.attributes).toEqual([]);
    expect(body.blocks).toEqual([]);
  });

  it("round-trips a single leading newline", () => {
    expectRoundTrip("\n");
  });

  it("round-trips a file with just comments", () => {
    expectRoundTrip("# comment 1\n# comment 2\n");
  });
});

describe("attributes", () => {
  it("parses a simple attribute", () => {
    const { body } = parseOK("foo = 1\n");
    expect(body.attributes).toHaveLength(1);
    const attr = body.attributes[0]!;
    expect(attr.kind).toBe("Attribute");
    expect(attr.name).toBe("foo");
    // M4: the RHS is now a structured expression. `1` → LiteralNode.
    expect(attr.expression.kind).toBe("Literal");
    if (attr.expression.kind === "Literal") {
      expect(attr.expression.value).toBe(1);
    }
  });

  it("parses multiple attributes", () => {
    const { body } = parseOK("a = 1\nb = 2\nc = 3\n");
    expect(body.attributes.map((a) => a.name)).toEqual(["a", "b", "c"]);
  });

  it("preserves comments around attributes on round-trip", () => {
    expectRoundTrip(
      "# leading\nfoo = 1 # trailing\n// another\nbar = 2\n",
    );
  });

  it("parses object-literal expressions as a structured ObjectNode", () => {
    const { body } = parseOK("x = { a = 1, b = 2 }\n");
    const expr = body.attributes[0]!.expression;
    expect(expr.kind).toBe("Object");
    if (expr.kind === "Object") {
      expect(expr.items).toHaveLength(2);
      expect(
        expr.items[0]!.key.kind === "Variable"
          ? expr.items[0]!.key.name
          : "?",
      ).toBe("a");
      expect(
        expr.items[1]!.key.kind === "Variable"
          ? expr.items[1]!.key.name
          : "?",
      ).toBe("b");
    }
  });

  it("captures tuple and call expressions", () => {
    expectRoundTrip("x = [1, 2, 3]\n");
    expectRoundTrip("y = f(1, 2, 3)\n");
    expectRoundTrip("z = f(a, b...)\n");
  });

  it("captures heredoc values", () => {
    expectRoundTrip("x = <<EOT\nhello\nEOT\n");
    expectRoundTrip("y = <<-EOT\n  hello\n  EOT\n");
  });

  it("captures quoted strings with interpolations", () => {
    expectRoundTrip('greeting = "hello ${name}!"\n');
    expectRoundTrip('msg = "${x}-${y}"\n');
  });
});

describe("blocks", () => {
  it("parses a block with zero labels", () => {
    const { body } = parseOK("block {\n  a = 1\n}\n");
    expect(body.blocks).toHaveLength(1);
    const blk = body.blocks[0]!;
    expect(blk.type).toBe("block");
    expect(blk.labels).toBe(null);
    expect(blk.body.attributes).toHaveLength(1);
  });

  it("parses a block with one string label", () => {
    const { body } = parseOK('module "m" {\n  source = "./m"\n}\n');
    const blk = body.blocks[0]!;
    expect(blk.type).toBe("module");
    expect(blk.labels!.labels).toEqual([{ value: "m", quoted: true }]);
  });

  it("parses a block with two string labels (Terraform resource)", () => {
    const input = 'resource "aws_s3_bucket" "b" {\n  acl = "private"\n}\n';
    const { body } = parseOK(input);
    const blk = body.blocks[0]!;
    expect(blk.type).toBe("resource");
    expect(blk.labels!.labels).toEqual([
      { value: "aws_s3_bucket", quoted: true },
      { value: "b", quoted: true },
    ]);
  });

  it("parses a block with three labels mixing quoted and bare", () => {
    const input = 'triple one "two" three {\n  x = 1\n}\n';
    const { body } = parseOK(input);
    const blk = body.blocks[0]!;
    expect(blk.labels!.labels).toEqual([
      { value: "one", quoted: false },
      { value: "two", quoted: true },
      { value: "three", quoted: false },
    ]);
  });

  it("parses an empty one-line block `a {}`", () => {
    const { body } = parseOK("a {}\n");
    const blk = body.blocks[0]!;
    expect(blk.body.attributes).toHaveLength(0);
    expect(blk.body.blocks).toHaveLength(0);
  });

  it("parses a one-line block with a single attribute `a { b = 1 }`", () => {
    const { body } = parseOK("a { b = 1 }\n");
    const blk = body.blocks[0]!;
    expect(blk.body.attributes).toHaveLength(1);
    expect(blk.body.attributes[0]!.name).toBe("b");
  });

  it("parses nested blocks", () => {
    const input = "outer {\n  inner {\n    x = 1\n  }\n}\n";
    const { body } = parseOK(input);
    const outer = body.blocks[0]!;
    expect(outer.body.blocks).toHaveLength(1);
    const inner = outer.body.blocks[0]!;
    expect(inner.type).toBe("inner");
    expect(inner.body.attributes[0]!.name).toBe("x");
  });

  it("parses a mix of attributes and blocks inside a body", () => {
    const input = 'resource "x" "y" {\n  name = "demo"\n  tags = {}\n  lifecycle {\n    create_before_destroy = true\n  }\n}\n';
    const { body } = parseOK(input);
    const res = body.blocks[0]!;
    expect(res.body.attributes.map((a) => a.name)).toEqual(["name", "tags"]);
    expect(res.body.blocks.map((b) => b.type)).toEqual(["lifecycle"]);
  });
});

describe("error recovery", () => {
  it("reports 'expected expression' when = is followed by a newline", () => {
    const source = new SourceFile("foo =\n");
    const result = parse(source, { bail: false });
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]!.message).toMatch(/expected expression/);
  });

  it("reports missing = after an identifier at top level", () => {
    const source = new SourceFile("foo\n");
    const result = parse(source, { bail: false });
    // `foo` followed by NEWLINE: after IDENT we expect '=' or block labels;
    // NEWLINE is neither.
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("reports unclosed blocks", () => {
    const source = new SourceFile("a {\n  x = 1\n");
    const result = parse(source, { bail: false });
    expect(result.errors.some((e) => /RBRACE|}/.test(e.message))).toBe(true);
  });

  it("continues parsing after a recoverable error", () => {
    const source = new SourceFile("oops\nfoo = 1\n");
    const result = parse(source, { bail: false });
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.body.attributes).toHaveLength(1);
    expect(result.body.attributes[0]!.name).toBe("foo");
  });

  it("throws immediately when bail is true (default)", () => {
    expect(() => parse(new SourceFile("oops\n"))).toThrow();
  });

  it("flags interpolations inside block labels", () => {
    const source = new SourceFile('block "${x}" {}\n');
    const result = parse(source, { bail: false });
    expect(
      result.errors.some((e) => /interpolation/.test(e.message)),
    ).toBe(true);
  });

  it("flags template-control sequences inside block labels", () => {
    const source = new SourceFile('block "%{if x}y%{endif}" {}\n');
    const result = parse(source, { bail: false });
    expect(
      result.errors.some((e) => /interpolation/.test(e.message)),
    ).toBe(true);
  });

  it("reports a non-IDENT first token in a body", () => {
    const source = new SourceFile("= 1\n");
    const result = parse(source, { bail: false });
    expect(
      result.errors.some((e) => /attribute or block/.test(e.message)),
    ).toBe(true);
  });

  it("reports non-label tokens between the block type and the brace", () => {
    // After consuming the first block label, a bare NUMBER cannot be a
    // second label — must be IDENT, OQUOTE, or LBRACE.
    const source = new SourceFile("block foo 42 {}\n");
    const result = parse(source, { bail: false });
    expect(
      result.errors.some((e) => /label or '\{'/.test(e.message)),
    ).toBe(true);
  });
});

describe("invalid escape sequences in quoted strings", () => {
  function errorsOf(input: string) {
    return parse(new SourceFile(input), { bail: false }).errors;
  }

  it("reports the escape Terraform rejects, at the backslash", () => {
    const input = 'a = "ends with a backslash \\. more"\n';
    const errors = errorsOf(input);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/^invalid escape sequence: '\\\.'/);
    expect(errors[0]!.line).toBe(1);
    expect(errors[0]!.column).toBe(input.indexOf("\\") + 1);
  });

  it("throws on the first invalid escape when bail is true (default)", () => {
    expect(() => parse(new SourceFile('a = "x\\qy"\n'))).toThrow(
      /invalid escape sequence/,
    );
  });

  it.each([
    ["attribute value", 'a = "x\\qy"\n'],
    ["block label", 'block "la\\qbel" {}\n'],
    ["second block label", 'resource "t" "n\\q" {}\n'],
    ["object key", 'a = { "k\\q" = 1 }\n'],
    ["object value", 'a = { k = "v\\q" }\n'],
    ["tuple item", 'a = ["x", "y\\q"]\n'],
    ["function argument", 'a = f("x\\q")\n'],
    ["quoted string inside an interpolation", 'a = "${"x\\qy"}"\n'],
    ["text next to an interpolation", 'a = "${x}\\q"\n'],
    ["if-directive body", 'a = "%{ if c }x\\qy%{ endif }"\n'],
    ["else-directive body", 'a = "%{ if c }x%{ else }\\q%{ endif }"\n'],
    ["for-directive body", 'a = "%{ for v in vs }\\q%{ endfor }"\n'],
    ["quoted string in a heredoc interpolation", 'a = <<EOT\n${"x\\q"}\nEOT\n'],
    ["for-expression", 'a = [for v in vs : "x\\q"]\n'],
    ["conditional", 'a = c ? "x\\q" : "y"\n'],
  ])("reports an invalid escape: %s", (_ctx, input) => {
    const errors = errorsOf(input);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(
        /^invalid escape sequence: '\\q' is not a valid escape/,
      ),
    ]);
  });

  it("accepts every escape HCL defines", () => {
    parseOK('a = "\\n\\r\\t\\"\\\\\\u00e9\\U0001F389$${x}%%{y}"\n');
  });

  it("accepts backslashes in heredoc bodies as plain text", () => {
    expectRoundTrip("a = <<EOT\nC:\\path\\. \\q \\u00e\nEOT\n");
    expectRoundTrip("a = <<-EOT\n  \\d+\\.\\d+\n  EOT\n");
  });

  it("keeps the CST lossless when recovering from an invalid escape", () => {
    const input = 'a = "x\\qy${z}\\.w"\nblock "l\\q" {}\n';
    const result = parse(new SourceFile(input), { bail: false });
    expect(result.errors).toHaveLength(3);
    expect(print(result.body)).toBe(input);
  });
});

describe("identifiers that start with an underscore", () => {
  // bail: true, so a regression fails on the first error rather than
  // running `{ ... }` recovery on an INVALID token.
  function expectStrictRoundTrip(input: string) {
    const { body } = parse(new SourceFile(input));
    expect(print(body)).toBe(input);
  }

  it.each([
    ["variable", "a = _foo\n"],
    ["bare underscore", "a = _\n"],
    [
      "traversal step (import block target)",
      "to = aws_route53_record._46fe0a1b_example_org_A\n",
    ],
    ["splat traversal", "a = x[*]._y\n"],
    ["attribute name", "_b = 1\n"],
    ["block type", "_blk {\n  _attr = 1\n}\n"],
    ["bare block label", "resource _lbl {}\n"],
    ["object key", "a = { _k = 1 }\n"],
    ["function name", "a = _f(1)\n"],
    ["for-expression key and value", "a = [for _, _v in xs : _v]\n"],
    ["for-expression object form", "a = { for _k, v in m : _k => v }\n"],
    ["template for directive", 'a = "%{ for _, s in xs }${s}%{ endfor }"\n'],
    ["template interpolation", 'a = "${_x}"\n'],
    ["heredoc delimiter", "a = <<_EOT\nhi\n_EOT\n"],
    ["indented heredoc delimiter", "a = <<-_EOT\n  hi\n  _EOT\n"],
  ])("parses a leading underscore: %s", (_ctx, input) => {
    expectStrictRoundTrip(input);
  });

  it("parses a Terraform import block with an underscore resource name", () => {
    const input =
      'import {\n  to = aws_route53_record._46fe0a1b\n  id = "Z123_example.org_A"\n}\n';
    const { body } = parse(new SourceFile(input));
    expect(body.blocks[0]!.type).toBe("import");
    expect(print(body)).toBe(input);
  });
});

describe("round-trip property", () => {
  const cases: Array<{ name: string; input: string }> = [
    { name: "empty file", input: "" },
    { name: "single attribute", input: "foo = 1\n" },
    { name: "multiple attributes", input: "a = 1\nb = 2\nc = 3\n" },
    { name: "attribute without final newline", input: "foo = 1" },
    { name: "blank lines between statements", input: "a = 1\n\n\nb = 2\n" },
    {
      name: "zero-label block",
      input: "block {\n  a = 1\n}\n",
    },
    {
      name: "one-label block",
      input: 'module "m" {\n  source = "./m"\n}\n',
    },
    {
      name: "two-label block",
      input: 'resource "t" "n" {\n  a = 1\n}\n',
    },
    {
      name: "three-label block",
      input: "t l1 l2 l3 {\n  a = 1\n}\n",
    },
    { name: "empty one-line block", input: "a {}\n" },
    {
      name: "one-line block with attribute",
      input: "a { b = 1 }\n",
    },
    {
      name: "nested blocks",
      input: "outer {\n  inner {\n    x = 1\n  }\n}\n",
    },
    {
      name: "mixed attrs + blocks",
      input:
        'resource "x" "y" {\n  name = "demo"\n  tags = {}\n  lifecycle {\n    create_before_destroy = true\n  }\n}\n',
    },
    {
      name: "heredoc attribute",
      input: "x = <<EOT\nhello\n${name}\nEOT\n",
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
      name: "comments preserved",
      input:
        "# head\nfoo = 1 # trailing\n\n# between\nbar = 2\n// slash\nbaz = 3\n",
    },
    {
      name: "tuple and object expressions",
      input: "xs = [1, 2, 3]\nobj = {a = 1, b = 2}\n",
    },
    {
      name: "string interpolations",
      input: 'g = "hello ${name}"\nh = "${x}-${y}"\n',
    },
    {
      name: "operators in expressions",
      input: "x = a + b * c\ny = !cond && other || third\n",
    },
    {
      name: "conditional expression",
      input: "x = a > b ? c : d\n",
    },
    {
      name: "function call with splat",
      input: "x = f(a, b, c...)\n",
    },
    {
      name: "traversal and indexing",
      input: "x = a.b[0].c\n",
    },
    {
      name: "for expression",
      input: "x = { for k, v in m : k => v if v > 0 }\n",
    },
    {
      name: "strip markers",
      input: 'x = "${~ trim ~}"\n',
    },
    {
      name: "block with blank-lined body",
      input: "a {\n  x = 1\n\n  y = 2\n}\n",
    },
    {
      name: "tabs and mixed whitespace",
      input: "foo\t=\t1\n\tbar = 2\n",
    },
  ];

  for (const { name, input } of cases) {
    it(`round-trips: ${name}`, () => {
      expectRoundTrip(input);
    });
  }
});
