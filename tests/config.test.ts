import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  test("parses full JSONC config with comments and trailing commas", () => {
    const raw = `{
      // required skills
      "requiredSkills": ["review", "coderabbit:review"],
      /* sha policy */
      "sha": "pushed",
      "statusName": "My Check",
    }`;
    expect(parseConfig(raw)).toEqual({
      requiredSkills: ["review", "coderabbit:review"],
      sha: "pushed",
      statusName: "My Check",
    });
  });

  test("merges defaults for missing fields", () => {
    expect(parseConfig('{ "requiredSkills": ["a"] }')).toEqual({
      requiredSkills: ["a"],
      sha: "head",
      statusName: "Skilled PR",
    });
  });

  test("user fields override defaults", () => {
    expect(parseConfig('{ "sha": "pushed" }').sha).toBe("pushed");
  });

  test("returns defaults for empty object", () => {
    expect(parseConfig("{}")).toEqual({
      requiredSkills: ["review"],
      sha: "head",
      statusName: "Skilled PR",
    });
  });

  test("does not mangle // or /* */ inside strings (string-aware)", () => {
    // This is the key correctness win vs the old regex parser.
    const raw = `{ "statusName": "CI // PR review", "sha": "head" }`;
    expect(parseConfig(raw).statusName).toBe("CI // PR review");
  });

  test("preserves /* ... */ inside strings", () => {
    const raw = `{ "statusName": "see /* old docs */ for context" }`;
    expect(parseConfig(raw).statusName).toBe("see /* old docs */ for context");
  });

  test("throws on invalid JSON with a descriptive message", () => {
    expect(() => parseConfig("{ not valid }")).toThrow(/Invalid \.skilledpr\.jsonc/);
  });

  test("throws when top-level is an array", () => {
    expect(() => parseConfig("[]")).toThrow(/top-level value must be an object/);
  });

  test("throws when top-level is a string", () => {
    expect(() => parseConfig('"just a string"')).toThrow(/top-level value must be an object/);
  });
});
