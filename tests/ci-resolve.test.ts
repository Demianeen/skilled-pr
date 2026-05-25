import { describe, expect, test } from "vitest";
import { formatResolution, parseCIResolveArgs } from "../src/ci-resolve";
import type { PRContext, ResolvedProfile } from "../src/resolve";

describe("parseCIResolveArgs", () => {
  test("accepts --pr <num>", () => {
    const result = parseCIResolveArgs(["--pr", "42"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prNumber).toBe(42);
      expect(result.json).toBe(false);
      expect(result.post).toBe(false);
    }
  });

  test("accepts --pr=<num> inline form", () => {
    const result = parseCIResolveArgs(["--pr=99"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prNumber).toBe(99);
  });

  test("accepts --json and --post together", () => {
    const result = parseCIResolveArgs(["--pr", "1", "--json", "--post"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.json).toBe(true);
      expect(result.post).toBe(true);
    }
  });

  test("rejects missing --pr", () => {
    const result = parseCIResolveArgs(["--json"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--pr.*required/);
  });

  test("rejects --pr with no value", () => {
    const result = parseCIResolveArgs(["--pr"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--pr requires a value/);
  });

  test("rejects --pr= empty", () => {
    const result = parseCIResolveArgs(["--pr="]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--pr= requires a value/);
  });

  test("rejects --pr with a non-integer", () => {
    const result = parseCIResolveArgs(["--pr", "not-a-number"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/positive integer/);
  });

  test("rejects --pr with zero or negative", () => {
    expect(parseCIResolveArgs(["--pr", "0"]).ok).toBe(false);
    expect(parseCIResolveArgs(["--pr", "-1"]).ok).toBe(false);
  });

  test("rejects unknown flags", () => {
    const result = parseCIResolveArgs(["--pr", "1", "--unknown"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown argument/);
  });

  test("--pr followed by another flag should fail (caught by next.startsWith)", () => {
    const result = parseCIResolveArgs(["--pr", "--json"]);
    expect(result.ok).toBe(false);
  });
});

describe("formatResolution", () => {
  const baseContext: PRContext = {
    branch: "feat/x",
    author: "someone",
    labels: ["enhancement"],
    sha: "abc123",
  };
  const baseProfile: ResolvedProfile = {
    matchedRuleName: null,
    requiredSkills: ["review"],
    failOn: "error",
    summaryPrompt: "...",
    briefingPrompt: "...",
    execution: "main-agent",
    sessionBriefing: true,
    skipPolicy: "agent-decides",
  };

  test("renders PR number, branch, author, labels", () => {
    const out = formatResolution(42, baseContext, baseProfile);
    expect(out).toContain("PR #42");
    expect(out).toContain("feat/x");
    expect(out).toContain("someone");
    expect(out).toContain("enhancement");
  });

  test("renders 'top-level defaults apply' when no rule matched", () => {
    const out = formatResolution(1, baseContext, baseProfile);
    expect(out).toContain("(none — top-level defaults apply)");
  });

  test("renders matched rule name when set", () => {
    const out = formatResolution(1, baseContext, {
      ...baseProfile,
      matchedRuleName: "release-please-bypass",
    });
    expect(out).toContain("matched rule:    release-please-bypass");
  });

  test("omits author line when author is missing", () => {
    const out = formatResolution(1, { branch: "feat/x" }, baseProfile);
    expect(out).not.toContain("author:");
  });

  test("omits labels line when labels array is empty", () => {
    const out = formatResolution(1, { branch: "feat/x", labels: [] }, baseProfile);
    expect(out).not.toContain("labels:");
  });

  test("renders requiredSkills as JSON array", () => {
    const out = formatResolution(1, baseContext, {
      ...baseProfile,
      requiredSkills: ["review", "security:review"],
    });
    expect(out).toContain('requiredSkills:  ["review","security:review"]');
  });

  test("renders requiredSkills [] (bypass) explicitly", () => {
    const out = formatResolution(1, baseContext, {
      ...baseProfile,
      requiredSkills: [],
    });
    expect(out).toContain("requiredSkills:  []");
  });
});
