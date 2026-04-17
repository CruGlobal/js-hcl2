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
    expect(attr.expression.parts.map((t) => t.lexeme)).toEqual(["1"]);
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

  it("captures object-literal expressions as a single opaque span", () => {
    const { body } = parseOK("x = { a = 1, b = 2 }\n");
    const expr = body.attributes[0]!.expression;
    // Opaque: the span is flat tokens, not structured.
    expect(expr.parts[0]!.lexeme).toBe("{");
    expect(expr.parts[expr.parts.length - 1]!.lexeme).toBe("}");
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
