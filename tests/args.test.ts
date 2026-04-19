import { describe, expect, test } from "bun:test";
import { parseAttestArgs } from "../src/args";

describe("parseAttestArgs", () => {
  test("parses --skill <value>", () => {
    expect(parseAttestArgs(["--skill", "review"])).toEqual({
      ok: true,
      skill: "review",
    });
  });

  test("tolerates extra args before --skill", () => {
    expect(parseAttestArgs(["--foo", "bar", "--skill", "review"])).toEqual({
      ok: true,
      skill: "review",
    });
  });

  test("preserves namespaced skill names", () => {
    expect(parseAttestArgs(["--skill", "coderabbit:review"])).toEqual({
      ok: true,
      skill: "coderabbit:review",
    });
  });

  test("fails when --skill is missing", () => {
    const result = parseAttestArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing/i);
  });

  test("fails when --skill has no value", () => {
    const result = parseAttestArgs(["--skill"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/requires a value/i);
  });

  test("fails when --skill is followed by another flag", () => {
    const result = parseAttestArgs(["--skill", "--other"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/requires a value/i);
  });
});
