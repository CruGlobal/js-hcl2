import { describe, it, expect } from "vitest";
import HCL, {
  NotImplementedError,
  parse,
  parseDocument,
  stringify,
} from "../src/index.js";

describe("public API surface", () => {
  it("exports parse, stringify, parseDocument from the default export", () => {
    expect(HCL.parse).toBe(parse);
    expect(HCL.stringify).toBe(stringify);
    expect(HCL.parseDocument).toBe(parseDocument);
  });

  it("HCL.parse is live as of M5", () => {
    expect(parse("x = 1\n")).toEqual({ x: 1 });
  });

  it("HCL.stringify still throws NotImplementedError until M6", () => {
    expect(() => stringify({ x: 1 })).toThrow(NotImplementedError);
  });

  it("HCL.parseDocument still throws NotImplementedError until M7", () => {
    expect(() => parseDocument("x = 1")).toThrow(NotImplementedError);
  });
});
