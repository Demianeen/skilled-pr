import { describe, expect, test } from "bun:test";
import { parseConfig, stripJsonComments } from "../src/config";

describe("stripJsonComments", () => {
  test("removes single-line comments", () => {
    expect(stripJsonComments('{ "a": 1 // comment\n}')).toBe('{ "a": 1 \n}');
  });

  test("removes multi-line comments", () => {
    expect(stripJsonComments('{ /* hi */ "a": 1 }')).toBe('{  "a": 1 }');
  });

  test("removes trailing commas before } and ]", () => {
    expect(stripJsonComments('{ "a": [1, 2,], "b": 3, }')).toBe('{ "a": [1, 2], "b": 3}');
  });
});

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

  test("throws on invalid JSON", () => {
    expect(() => parseConfig("{ not valid }")).toThrow();
  });
});
