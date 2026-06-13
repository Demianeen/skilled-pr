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

// ---------------------------------------------------------------------------
// planStatusPosts — the static-branch-protection ↔ per-PR-rules bridge
// ---------------------------------------------------------------------------

import { planStatusPosts, clampDescription } from "../src/ci-resolve";
import type { SkilledPRConfig } from "../src/config";

function makeConfig(overrides: Partial<SkilledPRConfig> = {}): SkilledPRConfig {
  return {
    schemaVersion: 1,
    requiredSkills: ["review"],
    statusName: "Skilled PR",
    failOn: "error",
    summaryPrompt: null,
    briefingPrompt: null,
    autoReview: {
      trigger: "manual",
      execution: "subagent",
      parallel: true,
      sessionBriefing: true,
      skipPolicy: "agent-decides",
      askBeforeFiring: false,
    },
    rules: [],
    ...overrides,
  };
}

function makeProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    matchedRuleName: null,
    requiredSkills: ["review"],
    failOn: "error",
    summaryPrompt: "...",
    briefingPrompt: "...",
    ...overrides,
  };
}

describe("planStatusPosts", () => {
  test("default config, no rule matched → pending CTA per default skill", () => {
    const posts = planStatusPosts(makeConfig(), makeProfile());
    expect(posts).toEqual([
      {
        context: "Skilled PR / review",
        state: "pending",
        description: "Invoke /review in Claude Code or Codex to complete this gate.",
      },
    ]);
  });

  test("full bypass (rule resolves to []) → success on every registered context", () => {
    const config = makeConfig({
      rules: [{ name: "release-bypass", match: [{ branch: "release-*" }], requiredSkills: [] }],
    });
    const profile = makeProfile({ matchedRuleName: "release-bypass", requiredSkills: [] });
    const posts = planStatusPosts(config, profile);
    expect(posts).toEqual([
      {
        context: "Skilled PR / review",
        state: "success",
        description: "Not required for this PR (rule: release-bypass).",
      },
    ]);
  });

  test("subset rule → pending for the kept skill, success for the dropped one", () => {
    const config = makeConfig({
      requiredSkills: ["review", "cso"],
      rules: [{ name: "light", match: [{ branch: "docs/*" }], requiredSkills: ["review"] }],
    });
    const profile = makeProfile({ matchedRuleName: "light", requiredSkills: ["review"] });
    const posts = planStatusPosts(config, profile);
    expect(posts).toContainEqual(
      expect.objectContaining({ context: "Skilled PR / review", state: "pending" }),
    );
    expect(posts).toContainEqual(
      expect.objectContaining({
        context: "Skilled PR / cso",
        state: "success",
        description: "Not required for this PR (rule: light).",
      }),
    );
  });

  test("alternate-profile rule introducing a NEW skill → its context is planned AND the unused default gets success", () => {
    // The composition bug this planner exists to fix: a rule that swaps in
    // docs-review must (a) get a pending for docs-review — whose context
    // enable-gate now registers via the same collectAllSkillNames union —
    // and (b) release the default "review" context so branch protection
    // isn't left waiting on a status nothing will post.
    const config = makeConfig({
      rules: [{ name: "docs", match: [{ branch: "docs/*" }], requiredSkills: ["docs-review"] }],
    });
    const profile = makeProfile({ matchedRuleName: "docs", requiredSkills: ["docs-review"] });
    const posts = planStatusPosts(config, profile);
    expect(posts).toEqual([
      expect.objectContaining({ context: "Skilled PR / review", state: "success" }),
      expect.objectContaining({ context: "Skilled PR / docs-review", state: "pending" }),
    ]);
  });

  test("every resolved skill appears as a pending post (resolved ⊆ union invariant)", () => {
    const config = makeConfig({
      requiredSkills: ["review"],
      rules: [{ match: [{ branch: "sec/*" }], requiredSkills: ["review", "cso"] }],
    });
    const profile = makeProfile({ requiredSkills: ["review", "cso"] });
    const pendings = planStatusPosts(config, profile)
      .filter((p) => p.state === "pending")
      .map((p) => p.context);
    expect(pendings).toEqual(["Skilled PR / review", "Skilled PR / cso"]);
  });

  test("clamps over-long rule names to GitHub's 140-char description limit", () => {
    const longName = "r".repeat(200);
    const config = makeConfig({
      rules: [{ name: longName, match: [{ branch: "x" }], requiredSkills: [] }],
    });
    const profile = makeProfile({ matchedRuleName: longName, requiredSkills: [] });
    const [post] = planStatusPosts(config, profile);
    expect(post.description.length).toBeLessThanOrEqual(140);
    expect(post.description.endsWith("…")).toBe(true);
  });
});

describe("clampDescription", () => {
  test("returns short strings untouched", () => {
    expect(clampDescription("short")).toBe("short");
  });
  test("clamps at the limit with an ellipsis", () => {
    const out = clampDescription("x".repeat(141));
    expect(out.length).toBe(140);
    expect(out.endsWith("…")).toBe(true);
  });
});
