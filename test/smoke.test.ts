import { describe, it, expect } from "vitest";
import HCL, {
  NotImplementedError,
  parse,
  parseDocument,
  stringify,
} from "../src/index.js";

describe("M0 stubs", () => {
  it("exports parse, stringify, parseDocument from the default export", () => {
    expect(HCL.parse).toBe(parse);
    expect(HCL.stringify).toBe(stringify);
    expect(HCL.parseDocument).toBe(parseDocument);
  });

  it("throws NotImplementedError from parse", () => {
    expect(() => parse("x = 1")).toThrow(NotImplementedError);
  });

  it("throws NotImplementedError from stringify", () => {
    expect(() => stringify({ x: 1 })).toThrow(NotImplementedError);
  });

  it("throws NotImplementedError from parseDocument", () => {
    expect(() => parseDocument("x = 1")).toThrow(NotImplementedError);
  });
});
