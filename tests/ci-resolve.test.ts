import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatResolution, isFinalAttestationStatus, parseCIResolveArgs } from "../src/ci-resolve";
import type { PRContext, ResolvedProfile } from "../src/resolve";
import type { RunResult } from "../src/proc";

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

  test("rejects --pr values with numeric prefixes and trailing junk", () => {
    const result = parseCIResolveArgs(["--pr", "17abc"]);
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

describe("isFinalAttestationStatus", () => {
  test("does not treat ci-resolve bypass success as a final attestation", () => {
    expect(
      isFinalAttestationStatus({
        state: "success",
        description: "Not required for this PR (rule: release-bypass).",
      }),
    ).toBe(false);
  });

  test("does not treat ci-resolve CTA statuses as final attestations", () => {
    expect(
      isFinalAttestationStatus({
        state: "success",
        description: "Invoke /review in Claude Code or Codex to complete this gate.",
      }),
    ).toBe(false);
  });

  test("treats final skill status descriptions as attestations", () => {
    expect(isFinalAttestationStatus({ state: "success", description: "review: no findings" })).toBe(
      true,
    );
    expect(isFinalAttestationStatus({ state: "failure", description: "review: 1 error" })).toBe(
      true,
    );
  });

  test("preserves unknown final statuses rather than overwriting them", () => {
    expect(isFinalAttestationStatus({ state: "success", description: null })).toBe(true);
  });

  test("does not treat pending as a final attestation", () => {
    expect(
      isFinalAttestationStatus({
        state: "pending",
        description: "Invoke /review in Claude Code or Codex to complete this gate.",
      }),
    ).toBe(false);
  });
});

describe("ciResolve --post", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../src/proc");
  });

  function ok(stdout = ""): RunResult {
    return { stdout, stderr: "", exitCode: 0 };
  }

  function fail(stderr = "failed"): RunResult {
    return { stdout: "", stderr, exitCode: 1 };
  }

  function withConfigCwd(): string {
    const tmp = mkdtempSync(join(tmpdir(), "skilled-pr-ci-resolve-"));
    mkdirSync(join(tmp, ".skilledpr"));
    writeFileSync(
      join(tmp, ".skilledpr", "config.jsonc"),
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
    );
    return tmp;
  }

  function mockPostFlow(
    existingStatuses: unknown[],
    postResult: RunResult = ok(),
  ): ReturnType<typeof vi.fn> {
    return vi.fn((args: string[]): RunResult => {
      if (args[0] === "git" && args[1] === "remote" && args[2] === "get-url") {
        return ok("git@github.com:Demianeen/skilled-pr.git\n");
      }
      if (
        args[0] === "gh" &&
        args[1] === "api" &&
        args[2] === "repos/Demianeen/skilled-pr/pulls/1"
      ) {
        return ok(
          JSON.stringify({
            head: { ref: "feat/skilled-pr", sha: "abc123" },
            user: { login: "Demianeen" },
            labels: [],
          }),
        );
      }
      if (
        args[0] === "gh" &&
        args[1] === "api" &&
        args[2] === "repos/Demianeen/skilled-pr/commits/abc123/statuses"
      ) {
        return ok(JSON.stringify(existingStatuses));
      }
      if (
        args[0] === "gh" &&
        args[1] === "api" &&
        args[2] === "repos/Demianeen/skilled-pr/statuses/abc123"
      ) {
        return postResult;
      }
      throw new Error(`unexpected command: ${JSON.stringify(args)}`);
    });
  }

  async function loadMockedCIResolve(runMock: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    vi.doMock("../src/proc", () => ({ run: runMock }));
    return import("../src/ci-resolve");
  }

  test("replaces an old ci-resolve bypass success when this PR now requires review", async () => {
    const previousCwd = process.cwd();
    const tmp = withConfigCwd();
    const runMock = mockPostFlow([
      {
        context: "Skilled PR / review",
        state: "success",
        description: "Not required for this PR (rule: release-bypass).",
      },
    ]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(tmp);
    try {
      const { ciResolve } = await loadMockedCIResolve(runMock);

      await ciResolve(["--pr", "1", "--post"]);

      const statusPost = runMock.mock.calls.find(
        ([args]) => args[2] === "repos/Demianeen/skilled-pr/statuses/abc123",
      )?.[0];
      expect(statusPost).toContain("state=pending");
      expect(statusPost).toContain("context=Skilled PR / review");
      expect(statusPost).toContain(
        "description=Invoke /review in Claude Code or Codex to complete this gate.",
      );
    } finally {
      process.chdir(previousCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("leaves a real review attestation untouched", async () => {
    const previousCwd = process.cwd();
    const tmp = withConfigCwd();
    const runMock = mockPostFlow([
      {
        context: "Skilled PR / review",
        state: "success",
        description: "review: no findings",
      },
    ]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(tmp);
    try {
      const { ciResolve } = await loadMockedCIResolve(runMock);

      await ciResolve(["--pr", "1", "--post"]);

      const postCalls = runMock.mock.calls.filter(
        ([args]) => args[2] === "repos/Demianeen/skilled-pr/statuses/abc123",
      );
      expect(postCalls).toHaveLength(0);
    } finally {
      process.chdir(previousCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("does not repost an identical ci-resolve pending status", async () => {
    const previousCwd = process.cwd();
    const tmp = withConfigCwd();
    const runMock = mockPostFlow([
      {
        context: "Skilled PR / review",
        state: "pending",
        description: "Invoke /review in Claude Code or Codex to complete this gate.",
      },
    ]);
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => {
      logged.push(String(msg));
      return undefined as unknown as void;
    });
    process.chdir(tmp);
    try {
      const { ciResolve } = await loadMockedCIResolve(runMock);

      await ciResolve(["--pr", "1", "--post"]);

      const postCalls = runMock.mock.calls.filter(
        ([args]) => args[2] === "repos/Demianeen/skilled-pr/statuses/abc123",
      );
      expect(postCalls).toHaveLength(0);
      expect(logged.join("\n")).toContain("already up to date");
    } finally {
      process.chdir(previousCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("prints classified gh errors when PR metadata fetch fails", async () => {
    const previousCwd = process.cwd();
    const tmp = withConfigCwd();
    const runMock = vi.fn((args: string[]): RunResult => {
      if (args[0] === "git" && args[1] === "remote" && args[2] === "get-url") {
        return ok("git@github.com:Demianeen/skilled-pr.git\n");
      }
      if (
        args[0] === "gh" &&
        args[1] === "api" &&
        args[2] === "repos/Demianeen/skilled-pr/pulls/1"
      ) {
        return { stdout: "", stderr: "gh: Unauthorized (HTTP 401)", exitCode: 1 };
      }
      throw new Error(`unexpected command: ${JSON.stringify(args)}`);
    });
    const errored: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => {
      errored.push(String(msg));
      return undefined as unknown as void;
    });
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    process.chdir(tmp);
    try {
      const { ciResolve } = await loadMockedCIResolve(runMock);

      await expect(ciResolve(["--pr", "1"])).rejects.toThrow(/__exit__/);

      const output = errored.join("\n");
      expect(output).toContain("could not fetch PR #1");
      expect(output).toContain("gh is not authenticated");
      expect(output).toContain("gh auth login");
    } finally {
      process.chdir(previousCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exits nonzero when status posting fails", async () => {
    const previousCwd = process.cwd();
    const tmp = withConfigCwd();
    const runMock = mockPostFlow([], fail("gh: Forbidden (HTTP 403)"));
    const errored: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((msg) => {
      errored.push(String(msg));
      return undefined as unknown as void;
    });
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    process.chdir(tmp);
    try {
      const { ciResolve } = await loadMockedCIResolve(runMock);

      await expect(ciResolve(["--pr", "1", "--post"])).rejects.toThrow(/__exit__/);

      const output = errored.join("\n");
      expect(output).toContain("failed to post 1 status");
      expect(output).toContain("must fail");
    } finally {
      process.chdir(previousCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
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
