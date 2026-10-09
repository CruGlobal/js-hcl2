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

  it("stores a quoted label's decoded text and keeps its source", () => {
    const input = 'b "\\u00e9\\"" "$${x}" bare {}\n';
    const { body } = parseOK(input);
    expect(body.blocks[0]!.labels!.labels).toEqual([
      { value: 'é"', quoted: true },
      { value: "${x}", quoted: true },
      { value: "bare", quoted: false },
    ]);
    expect(print(body)).toBe(input);
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

describe("each statement ends at a line break", () => {
  // Every case and position here was checked against hashicorp/hcl v2.24.0
  // (the version terraform 1.13 uses) and `terraform fmt`.
  function errorsOf(input: string) {
    return parse(new SourceFile(input), { bail: false }).errors;
  }

  it.each([
    ["two arguments", "a = 1 b = 2\n", 1, 7],
    ["two arguments, no final newline", "a = 1 b = 2", 1, 7],
    ["a stray '}' after an argument", "a = 1 }\n", 1, 7],
    ["an argument that closes its block", "b {\n  a = 1 }\n", 2, 9],
    ["two arguments in a block", "b {\n  a = 1 b = 2\n}\n", 2, 9],
    ["a one-line comment between them", "a = 1 /* c */ b = 2\n", 1, 15],
    ["a comment that hides the line break", "a = 1 /* multi\nline */ b = 2\n", 2, 9],
  ])("rejects %s: missing newline after argument", (_ctx, input, line, column) => {
    const errors = errorsOf(input);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^missing newline after argument/),
    ]);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
  });

  it.each([
    ["an argument after a block", "b {} c = 1\n", 1, 6],
    ["two blocks", "b {} c {}\n", 1, 6],
    ["two one-line blocks", "b { a = 1 } c { d = 2 }\n", 1, 13],
    ["an argument after a closing brace", "b {\n  a = 1\n} c = 1\n", 3, 3],
    ["an argument after a nested block", "b {\n  c {} d = 1\n}\n", 2, 8],
    ["a comment that hides the line break", "b {} /* x\ny */ c = 1\n", 2, 6],
  ])("rejects %s: missing newline after block definition", (_ctx, input, line, column) => {
    const errors = errorsOf(input);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^missing newline after block definition/),
    ]);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
  });

  it("rejects a comma between arguments", () => {
    const errors = errorsOf("a = 1, b = 2\n");
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^unexpected comma after argument/),
    ]);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([1, 6]);
  });

  it.each([
    ["a second argument", "b { a = 1 b = 2 }\n", 1, 11, /^invalid single-argument block definition/],
    ["a comma", "b { a = 1, b = 2 }\n", 1, 10, /^invalid single-argument block definition/],
    ["a trailing comma", "b { a = 1 ,}\n", 1, 11, /^invalid single-argument block definition/],
    ["a closing brace on the next line", "b { a = 1\n}\n", 1, 10, /^invalid single-argument block definition/],
    ["a comment, then the brace on the next line", "b { a = 1 # c\n}\n", 1, 14, /^invalid single-argument block definition/],
    ["a nested block", "b { c {} }\n", 1, 5, /^argument definition required/],
    ["a nested block with a label", 'b { c "x" {} }\n', 1, 5, /^argument definition required/],
  ])("rejects a one-line block with %s", (_ctx, input, line, column, message) => {
    const errors = errorsOf(input);
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(message)]);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
  });

  it("throws on the first error when bail is true (default)", () => {
    expect(() => parse(new SourceFile("a = 1 b = 2\n"))).toThrow(
      /missing newline after argument/,
    );
  });

  it.each([
    ["an argument with no final newline", "a = 1"],
    ["a block with no final newline", "b {}"],
    ["a line comment", "a = 1 # c\nb = 2\n"],
    ["a // comment", "a = 1 // c\nb = 2\n"],
    ["a comment before the line break", "a = 1 /* c */\nb = 2\n"],
    ["a multi-line comment, then a line break", "a = 1 /* multi\nline */\nb = 2\n"],
    ["a comment after a block", "b {} /* x\ny */\n"],
    ["CRLF line breaks", "a = 1\r\nb = 2\r\n"],
    ["a one-line block", "b { a = 1 }\n"],
    ["a one-line block with no spaces", "b {a=1}\n"],
    ["an empty one-line block", "b { }\n"],
    ["a one-line block and a comment", "b { a = 1 } # c\n"],
    ["a comment before a one-line argument", "b { /* c */ a = 1 }\n"],
    ["a comment after a one-line argument", "b { a = 1 /* c */ }\n"],
    ["a comment after the opening brace", "b { # c\n  a = 1\n}\n"],
    ["a multi-line object in a one-line block", "b { a = { x = 1\n} }\n"],
    ["a multi-line list in a one-line block", "b { a = [1,\n2] }\n"],
  ])("accepts %s", (_ctx, input) => {
    expectRoundTrip(input);
  });

  it("keeps parsing on the next line and stays lossless", () => {
    const input = "a = 1 b = 2\nc = 3\n";
    const result = parse(new SourceFile(input), { bail: false });
    expect(result.errors).toHaveLength(1);
    expect(result.body.attributes.map((a) => a.name)).toEqual(["a", "c"]);
    expect(print(result.body)).toBe(input);
  });

  it("lets a '}' after an argument still close its block", () => {
    const input = "b {\n  a = 1 }\nc = 2\n";
    const result = parse(new SourceFile(input), { bail: false });
    expect(result.errors).toHaveLength(1);
    expect(result.body.blocks[0]!.body.attributes.map((a) => a.name)).toEqual(["a"]);
    expect(result.body.attributes.map((a) => a.name)).toEqual(["c"]);
    expect(print(result.body)).toBe(input);
  });

  it("reads the rest of a one-line block that runs onto more lines", () => {
    const input = "b { a = 1\n  c = 2\n}\nd = 3\n";
    const result = parse(new SourceFile(input), { bail: false });
    expect(result.errors).toHaveLength(1);
    expect(result.body.blocks[0]!.body.attributes.map((a) => a.name)).toEqual(["a", "c"]);
    expect(result.body.attributes.map((a) => a.name)).toEqual(["d"]);
    expect(print(result.body)).toBe(input);
  });
});

describe("a lone CR", () => {
  // hashicorp/hcl ends lines only at LF or CRLF, and reports a CR on its
  // own as "Invalid character" (inside a quoted string it is "Invalid
  // multi-line string", covered below).
  function errorsOf(input: string) {
    return parse(new SourceFile(input), { bail: false }).errors;
  }

  it.each([
    ["between arguments", "a = 1\rb = 2\n", 1, 6],
    ["at the start of the file", "\ra = 1\n", 1, 1],
    ["at the end of the file", "a = 1\r", 1, 6],
    ["before a CRLF", "a = 1\r\r\n", 1, 6],
    ["in a block", "b {\r}\n", 1, 4],
    ["inside brackets", "a = [1,\r2]\n", 1, 8],
    ["inside parentheses", "a = (1\r+ 2)\n", 1, 7],
    ["inside an interpolation", 'a = "${x\r}"\n', 1, 9],
    ["inside a directive", 'a = "%{ if x\r}y%{ endif }"\n', 1, 13],
    ["in a heredoc body", "a = <<EOT\nx\ry\nEOT\n", 2, 2],
    ["in an indented heredoc body", "a = <<-EOT\n  x\r  y\n  EOT\n", 2, 4],
    ["just before a heredoc's closing marker", "a = <<EOT\nx\rEOT\n", 2, 2],
    ["after a heredoc's closing marker", "a = <<EOT\nx\nEOT\r", 3, 4],
  ])("reports it once as an invalid character: %s", (_ctx, input, line, column) => {
    const errors = errorsOf(input);
    expect(errors[0]!.message).toMatch(/^invalid character/);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
    expect(errors.filter((e) => /^invalid character/.test(e.message))).toHaveLength(1);
  });

  it("rejects a lone CR after a heredoc's opening marker", () => {
    expect(errorsOf("a = <<EOT\rx\nEOT\n").length).toBeGreaterThan(0);
  });

  it("throws when bail is true (default)", () => {
    expect(() => parse(new SourceFile("a = 1\rb = 2\n"))).toThrow(/^invalid character/);
  });

  it("does not end a # comment, as in Terraform", () => {
    const { body } = parseOK("a = 1 # c\rb = 2\n");
    expect(body.attributes.map((a) => a.name)).toEqual(["a"]);
  });

  it.each([
    ["a // comment", "// c\rb = 2\n"],
    ["a /* */ comment", "/* a\rb */ x = 1\n"],
    ["CRLF", "a = 1\r\n"],
    ["a blank CRLF line", "a = 1\n\r\n"],
    ["a CRLF heredoc", "a = <<EOT\r\nx\r\nEOT\r\n"],
  ])("accepts a CR in %s", (_ctx, input) => {
    expectRoundTrip(input);
  });

  it("keeps parsing on the next line and stays lossless", () => {
    const input = "a = 1\rb = 2\nc = 3\n";
    const result = parse(new SourceFile(input), { bail: false });
    expect(result.errors).toHaveLength(1);
    expect(result.body.attributes.map((a) => a.name)).toEqual(["a", "c"]);
    expect(print(result.body)).toBe(input);
  });
});

describe("template directives that do not balance", () => {
  // Errors and positions from hashicorp/hcl (hclsyntax parser_template.go).
  function errorsOf(input: string) {
    return parse(new SourceFile(input), { bail: false }).errors;
  }

  const missingEndif = (line: number, column: number) =>
    `unexpected end of template: the if directive at line ${line}, column ${column} is missing its endif directive`;
  const missingEndfor = (line: number, column: number) =>
    `unexpected end of template: the for directive at line ${line}, column ${column} is missing its endfor directive`;

  it.each([
    ["an if at the closing quote", 'a = "%{ if x }in"\n', 1, 17, missingEndif(1, 6)],
    ["an if with an else", 'a = "%{ if x }a%{ else }b"\n', 1, 26, missingEndif(1, 6)],
    ["an empty if", 'a = "%{ if x }"\n', 1, 15, missingEndif(1, 6)],
    ["the outer of two ifs", 'a = "%{ if x }%{ if y }a%{ endif }"\n', 1, 35, missingEndif(1, 6)],
    ["an if before an interpolation", 'a = "%{ if x }${y}"\n', 1, 19, missingEndif(1, 6)],
    ["a for", 'a = "%{ for v in vs }x"\n', 1, 23, missingEndfor(1, 6)],
    ["an if in a heredoc", "a = <<EOT\n%{ if x }in\nEOT\n", 3, 1, missingEndif(2, 1)],
  ])("stops %s at the end of the template", (_ctx, input, line, column, message) => {
    const errors = errorsOf(input);
    expect(errors.map((e) => e.message)).toEqual([message]);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
  });

  it.each([
    ["an endif with no if", 'a = "%{ endif }"\n', 1, 6, /^unexpected endif directive: the control directives in this template are unbalanced/],
    ["an else with no if", 'a = "%{ else }"\n', 1, 6, /^unexpected else directive: the control directives in this template are unbalanced/],
    ["an endfor with no for", 'a = "%{ endfor }"\n', 1, 6, /^unexpected endfor directive: the control directives in this template are unbalanced/],
    ["a stripped endif with no if", 'a = "%{~ endif ~}"\n', 1, 6, /^unexpected endif directive/],
    ["an endfor that closes an if", 'a = "%{ if x }%{ endfor }"\n', 1, 15, /^unexpected endfor directive: expected an endif directive for the if at line 1, column 6/],
    ["an endif that closes a for", 'a = "%{ for v in vs }%{ endif }"\n', 1, 22, /^unexpected endif directive: expected an endfor directive for the for at line 1, column 6/],
    ["an else in a for", 'a = "%{ for v in vs }%{ else }%{ endfor }"\n', 1, 22, /^unexpected else directive: a for directive cannot have an else clause/],
    ["a second else", 'a = "%{ if x }%{ else }%{ else }%{ endif }"\n', 1, 24, /^unexpected else directive: the if directive at line 1, column 6 already has an else clause/],
  ])("rejects %s", (_ctx, input, line, column, message) => {
    const errors = errorsOf(input);
    expect(errors[0]!.message).toMatch(message);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
    expect(print(parse(new SourceFile(input), { bail: false }).body)).toBe(input);
  });

  it("throws when bail is true (default)", () => {
    expect(() => parse(new SourceFile('a = "%{ if x }in"\n'))).toThrow(
      /^unexpected end of template/,
    );
  });

  it.each([
    ["an if and an else", 'a = "%{ if x }a%{ else }b%{ endif }"\n'],
    ["an if in a for", 'a = "%{ for v in vs }%{ if v }x%{ endif }%{ endfor }"\n'],
    ["strip markers on every marker", 'a = "%{~ if x ~}a%{~ else ~}b%{~ endif ~}"\n'],
  ])("accepts %s", (_ctx, input) => {
    expectRoundTrip(input);
  });
});

describe("line breaks inside a { for } expression", () => {
  // hclsyntax ignores line breaks anywhere inside a for expression
  // (finishParsingForExpr), even in an object `{ for ... }`, which is
  // otherwise newline-sensitive. Each body below has a line break inside
  // a value; Terraform accepts every one in every context.
  const bodies = [
    "{for k, v in x : k => v\n.arn}",
    "{for k, v in x : k => v.a\n+ v.b}",
    "{for k, v in x : k => v.a +\nv.b}",
    "{for k, v in x : k => v if v.a\n&& v.b}",
    "{for k, v in x : k => v if v.a &&\nv.b}",
    "{for k, v in x : k => v\n? 1 : 2}",
    "{for k, v in x : k => v ?\n1 : 2}",
    "{for k, v in x : k => f(v)\n[0]}",
    "{for k, v in x : k\n=> v}",
    "{for k, v in x : k => v\nif v}",
    "{for k, v in x : k => v\n}",
    "{for k, v in x : k => v\n...}",
    "{for k, v in x : k => {a = v\nb = 2}}",
    "{\nfor k, v in x : k => v\n.arn}",
    "{ # c\nfor k, v in x : k => v\n.arn}",
    "{ /* c */ for k, v in x : k => v\n.arn}",
    "{for k, v in x : k => [for w in v : w\n.y]}",
    "{for k, v in x : k => v[*\n].y}",
  ];
  const contexts: Array<[string, (b: string) => string]> = [
    ["at the top level", (b) => `a = ${b}\n`],
    ["in ${ }", (b) => `a = "\${ ${b} }"\n`],
    ["in a heredoc", (b) => `a = <<EOT\n\${jsonencode(${b})}\nEOT\n`],
    ["in %{ for }", (b) => `a = "%{ for v in ${b} }x%{ endfor }"\n`],
  ];

  it.each(contexts.flatMap(([where, wrap]) => bodies.map((b) => [where, wrap(b)])))(
    "accepts a line break inside a value %s: %j",
    (_where, input) => {
      expectRoundTrip(input);
    },
  );

  it("still needs separators between the items of an object inside it", () => {
    const errors = parse(new SourceFile("a = {for k in x : k => {y = 1 z = 2}}\n"), {
      bail: false,
    }).errors;
    expect(errors[0]!.message).toMatch(/^expected ',' or newline between object items/);
  });

  it.each([
    ["an argument named for", "b {\n  for = 1\n}\n"],
    ["a block named for", "b {\n  for x in {\n  }\n}\n"],
  ])("still reads a block body that starts with %s", (_ctx, input) => {
    const { body } = parseOK(input);
    expect(print(body)).toBe(input);
    const inner = body.blocks[0]!.body;
    expect([...inner.attributes, ...inner.blocks].map((s) => s.kind)).toEqual([
      input.includes("=") ? "Attribute" : "Block",
    ]);
  });
});

describe("objects over several lines inside ${ } and %{ }", () => {
  it.each([
    ["in ${ }", 'a = "${ {a = 1\nb = 2}.a }"\n'],
    ["with a blank line", 'a = "${ {a = 1\n\nb = 2\n}.a }"\n'],
    ["in %{ if }", 'a = "%{ if {a = 1\nb = 2}.a }x%{ endif }"\n'],
    ["in a call", 'a = "${ f({a = 1\nb = 2}) }"\n'],
    ["in a list", 'a = "${ [\n{a = 1\nb = 2}\n] }"\n'],
    ["in a for expression", 'a = "${ [for k, v in {a = 1\nb = 2} : k] }"\n'],
    ["in a heredoc", "a = <<EOT\n${ {a = 1\nb = 2}.a }\nEOT\n"],
    ["as an object for", 'a = "${ {for k, v in m :\nk => v} }"\n'],
  ])("accepts one %s", (_ctx, input) => {
    expectRoundTrip(input);
  });

  it("still needs a separator between items on one line", () => {
    const errors = parse(new SourceFile('a = "${ {a = 1 b = 2}.a }"\n'), {
      bail: false,
    }).errors;
    expect(errors[0]!.message).toMatch(/^expected ',' or newline between object items/);
  });

  it("reports only the unclosed '(' in ${ } inside an object", () => {
    const input = 'a = { k = "${ (x }"\nj = 2 }\n';
    const result = parse(new SourceFile(input), { bail: false });
    expect(result.errors.map((e) => e.message)).toEqual(["expected ')'"]);
    expect(print(result.body)).toBe(input);
  });
});

describe("strip markers out of place", () => {
  // hashicorp/hcl reports "Unsupported operator" for a `~` that does not
  // touch the `${`, `%{` or closing `}`.
  function errorsOf(input: string) {
    return parse(new SourceFile(input), { bail: false }).errors;
  }

  it.each([
    ["in an endif", 'a = "%{ if x }a%{ endif~ }"\n', 1, 24],
    ["in an else", 'a = "%{ if x }a%{ else~ }b%{ endif }"\n', 1, 23],
    ["in an endfor", 'a = "%{ for v in vs }a%{ endfor~ }"\n', 1, 32],
    ["after an if condition", 'a = "%{ if x~ }a%{ endif }"\n', 1, 13],
    ["between spaces after an if condition", 'a = "%{ if x ~ }a%{ endif }"\n', 1, 14],
    ["after a for collection", 'a = "%{ for v in vs~ }a%{ endfor }"\n', 1, 20],
    ["before a directive keyword", 'a = "%{ ~if x }a%{ endif }"\n', 1, 9],
    ["after an interpolated value", 'a = "${ x~ }"\n', 1, 10],
    ["between spaces in an interpolation", 'a = "${ x ~ }"\n', 1, 11],
    ["before an interpolated value", 'a = "${ ~x }"\n', 1, 9],
    ["outside a template", "a = ~1\n", 1, 5],
  ])("reports %s", (_ctx, input, line, column) => {
    const errors = errorsOf(input);
    expect(errors[0]!.message).toMatch(/^unsupported operator/);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
    expect(print(parse(new SourceFile(input), { bail: false }).body)).toBe(input);
  });

  it.each([
    ["on both sides of an interpolation", 'a = "${~ x ~}"\n'],
    ["with no spaces", 'a = "${~x~}"\n'],
    ["on every if marker", 'a = "%{~ if x ~}a%{~ else ~}b%{~ endif ~}"\n'],
    ["on every for marker", 'a = "%{~for v in vs~}a%{~endfor~}"\n'],
    ["in a heredoc", "a = <<EOT\n%{~ if x ~}\na\n%{~ endif ~}\nEOT\n"],
  ])("accepts strip markers %s", (_ctx, input) => {
    expectRoundTrip(input);
  });
});

describe("an unterminated /* comment", () => {
  // hashicorp/hcl rejects these too (it reads the `/` and `*` as
  // operators); the error here says what is wrong.
  function errorsOf(input: string) {
    return parse(new SourceFile(input), { bail: false }).errors;
  }

  it.each([
    ["alone", "/* abc", 1, 1],
    ["only the opener", "/*", 1, 1],
    ["after an argument", "a = 1 /* abc", 1, 7],
    ["on its own line", "a = 1\n/* abc", 2, 1],
    ["followed by a line break", "a = 1\n/*\n", 2, 1],
    ["in a block", "b {\n/* x\n}\n", 2, 1],
    ["in a list", "a = [1, /* x", 1, 9],
  ])("reports it at the /*: %s", (_ctx, input, line, column) => {
    const errors = errorsOf(input);
    expect(errors[0]!.message).toMatch(/^unterminated comment/);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([line, column]);
    expect(print(parse(new SourceFile(input), { bail: false }).body)).toBe(input);
  });

  it("throws when bail is true (default)", () => {
    expect(() => parse(new SourceFile("a = 1\n/* abc"))).toThrow(/^unterminated comment/);
  });

  it.each([
    ["a closed comment at the end of the file", "a = 1 /* abc */"],
    ["an empty comment", "/**/\n"],
  ])("accepts %s", (_ctx, input) => {
    expectRoundTrip(input);
  });
});

describe("an argument set twice in one body", () => {
  // hashicorp/hcl reports "Attribute redefined" while parsing a body
  // (hclsyntax ParseBody), so `terraform fmt` rejects it too.
  function errorsOf(input: string) {
    return parse(new SourceFile(input), { bail: false }).errors;
  }

  it("reports the second one and says where the first one is", () => {
    const errors = errorsOf("a = 1\na = 2\n");
    expect(errors.map((e) => e.message)).toEqual([
      'attribute redefined: the argument "a" was already set at line 1, ' +
        "column 1; each argument may be set only once",
    ]);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([2, 1]);
  });

  it("reports it inside a block", () => {
    const errors = errorsOf("b {\n  a = 1\n  a = 2\n}\n");
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^attribute redefined: the argument "a" was already set at line 2, column 3;/),
    ]);
    expect([errors[0]!.line, errors[0]!.column]).toEqual([3, 3]);
  });

  it("reports every repeat against the first one", () => {
    const errors = errorsOf("a = 1\na = 2\na = 3\n");
    expect(errors.map((e) => [e.line, e.message.match(/line \d+/)![0]])).toEqual([
      [2, "line 1"],
      [3, "line 1"],
    ]);
  });

  it("reports it after the line's own error", () => {
    const errors = errorsOf("a = 1 b = 2\na = 3\n");
    expect(errors.map((e) => e.message.split(":")[0])).toEqual([
      "missing newline after argument",
      "attribute redefined",
    ]);
  });

  it("throws when bail is true (default)", () => {
    expect(() => parse(new SourceFile("a = 1\na = 2\n"))).toThrow(
      /^attribute redefined/,
    );
  });

  it.each([
    ["the same name in different bodies", "a = 1\nb {\n  a = 2\n}\n"],
    ["two blocks of one type", "b {}\nb {}\n"],
    ["two one-line blocks with the same argument", "b { a = 1 }\nb { a = 2 }\n"],
    ["an argument and a block with one name", "a = 1\na {}\n"],
    ["a repeated object key", "a = { x = 1, x = 2 }\n"],
    ["names that differ only in case", "A = 1\na = 2\n"],
  ])("accepts %s", (_ctx, input) => {
    expectRoundTrip(input);
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

describe("raw newlines in quoted strings", () => {
  function errorsOf(input: string) {
    return parse(new SourceFile(input), { bail: false }).errors;
  }

  it("reports the newline Terraform rejects, at the newline", () => {
    const input = 'a = "abc\ndef"\n';
    const errors = errorsOf(input);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/^invalid multi-line string/);
    expect(errors[0]!.line).toBe(1);
    expect(errors[0]!.column).toBe(input.indexOf("\n") + 1);
  });

  it("throws on a raw newline when bail is true (default)", () => {
    expect(() => parse(new SourceFile('a = "x\ny"\n'))).toThrow(
      /invalid multi-line string/,
    );
  });

  it.each([
    ["LF", 'a = "abc\ndef"\n'],
    ["CRLF", 'a = "abc\r\ndef"\r\n'],
    ["lone CR", 'a = "abc\rdef"\n'],
    ["blank line", 'a = "abc\n\ndef"\n'],
    ["only a newline", 'a = "\n"\n'],
    ["after an interpolation", 'a = "${x}\ny"\n'],
    ["between template directives", 'a = "%{ if x }\n%{ endif }"\n'],
    ["block label", 'b "a\nb" {}\n'],
    ["object key", 'a = { "k\nk" = 1 }\n'],
    ["function argument", 'a = f("x\ny")\n'],
    ["quoted string in a heredoc interpolation", 'a = <<EOT\n${"a\nb"}\nEOT\n'],
  ])("reports a raw newline: %s", (_ctx, input) => {
    expect(errorsOf(input).map((e) => e.message)).toEqual([
      expect.stringMatching(/^invalid multi-line string/),
    ]);
  });

  it.each([
    ["interpolation", 'a = "${\nx\n}"\n'],
    ["call inside an interpolation", 'a = "${foo(\n1,\n2)}"\n'],
    ["if directive", 'a = "%{ if\nx }y%{ endif }"\n'],
    ["heredoc body", "a = <<EOT\nx\n\ny\nEOT\n"],
  ])("accepts newlines inside: %s", (_ctx, input) => {
    expectRoundTrip(input);
  });

  it("keeps the CST lossless when recovering from a raw newline", () => {
    const input = 'a = "x\ny"\nb "l\r\nm" {}\n';
    const result = parse(new SourceFile(input), { bail: false });
    expect(result.errors).toHaveLength(2);
    expect(print(result.body)).toBe(input);
  });
});

describe("provider-defined functions", () => {
  it.each([
    ["an attribute", 'a = provider::aws::arn_parse("x")\n'],
    ["multi-line arguments", 'a = provider::aws::arn_parse(\n  "x",\n)\n'],
    ["a line break after :: inside parentheses", "a = f(provider::\naws::g())\n"],
    ["an interpolation", 'a = "${provider::aws::arn_parse(x).account_id}"\n'],
    ["an if directive", 'a = "%{ if a::b() }x%{ endif }"\n'],
    ["a conditional", "a = x ? provider::a::b(1) : 2\n"],
    ["a conditional without spaces", "a = x ?y::z(1):2\n"],
    ["an object for expression", "a = { for k, v in m : k => provider::d::m(v) }\n"],
    ["a tuple for expression", "a = [for x in xs : provider::d::f(x)]\n"],
    ["an expanded argument", "a = f(provider::a::b(1)...)\n"],
    ["a one-line block", 'b "x" { c = d::e(1) }\n'],
    ["unary and binary operators", "a = !p::q(1) && r::s(2)\n"],
    ["an index and a splat", "a = provider::a::b(1)[0]\nb = provider::a::b(1)[*].c\n"],
  ])("parses a provider function in %s", (_ctx, input) => {
    expectRoundTrip(input);
  });

  it.each([
    ["no name after ::", "a = provider::\n", /^missing function name/],
    ["a line break after ::", "a = provider::\naws::g()\n", /^missing function name/],
    [":::", "a = provider:::aws::f(1)\n", /^missing function name/],
    ["no ( after the name", "a = provider::aws::arn_parse\n", /^missing open parenthesis/],
    ["one :: and no (", "a = b::c\n", /^missing open parenthesis/],
    ["( on the next line", "a = provider::a::b\n(1)\n", /^missing open parenthesis/],
    ["a conditional with :: and no (", "a = x ? y ::z\n", /^missing open parenthesis/],
  ])("reports %s as Terraform does", (_ctx, input, message) => {
    const result = parse(new SourceFile(input), { bail: false });
    expect(result.errors[0]?.message).toMatch(message);
    expect(print(result.body)).toBe(input);
  });

  it.each([
    ["an index", "a = x[0]::y()\n"],
    ["a call", "a = provider::aws::arn_parse()::x()\n"],
    ["an object", "a = { k = 1 } ::x\n"],
    ["a string", 'a = "x" ::"y"\n'],
  ])("rejects :: after %s", (_ctx, input) => {
    const result = parse(new SourceFile(input), { bail: false });
    expect(result.errors.length).toBeGreaterThan(0);
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
