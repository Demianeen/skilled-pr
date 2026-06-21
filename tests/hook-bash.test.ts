import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOnPushReminder,
  isGitPushInvocation,
  maybeOnPushReminder,
  stripLeadingChdir,
} from "../src/hook-bash";

describe("stripLeadingChdir", () => {
  test("strips `cd <path> AMP <command>`", () => {
    expect(stripLeadingChdir("cd /tmp && git push")).toBe("git push");
  });

  test("strips `cd <path> SEMI <command>`", () => {
    expect(stripLeadingChdir("cd /tmp ; git push")).toBe("git push");
  });

  test("strips `cd <quoted path> AMP <command>`", () => {
    expect(stripLeadingChdir(`cd "/path with space" && git push`)).toBe("git push");
  });

  test("returns command unchanged when no chdir prefix", () => {
    expect(stripLeadingChdir("git push")).toBe("git push");
  });

  test("does not strip a chdir embedded mid-command", () => {
    const cmd = "echo hello cd /tmp && git push";
    expect(stripLeadingChdir(cmd)).toBe(cmd);
  });
});

describe("isGitPushInvocation", () => {
  test("plain `git push`", () => {
    expect(isGitPushInvocation("git push")).toBe(true);
  });

  test("`git push origin main`", () => {
    expect(isGitPushInvocation("git push origin main")).toBe(true);
  });

  test("`git push --force-with-lease`", () => {
    expect(isGitPushInvocation("git push --force-with-lease")).toBe(true);
  });

  test("`git push -u origin feature/x`", () => {
    expect(isGitPushInvocation("git push -u origin feature/x")).toBe(true);
  });

  test("with leading chdir", () => {
    expect(isGitPushInvocation("cd /repo && git push")).toBe(true);
  });

  test("rejects `git push --dry-run`", () => {
    expect(isGitPushInvocation("git push --dry-run")).toBe(false);
  });

  test("rejects `git push --dry-run=server`", () => {
    expect(isGitPushInvocation("git push --dry-run=server")).toBe(false);
  });

  test("rejects `git pull`", () => {
    expect(isGitPushInvocation("git pull")).toBe(false);
  });

  test("rejects `git status`", () => {
    expect(isGitPushInvocation("git status")).toBe(false);
  });

  test("rejects non-git commands", () => {
    expect(isGitPushInvocation("echo git push")).toBe(false);
    expect(isGitPushInvocation("npm run push")).toBe(false);
  });

  test("rejects pipeline commands AFTER chdir strip", () => {
    expect(isGitPushInvocation("cd /repo && git push | tee log")).toBe(false);
  });

  test("rejects pipe-separated chdir prefixes", () => {
    expect(isGitPushInvocation("cd /repo | git push")).toBe(false);
  });

  test("rejects when push is second in a multi-command chain", () => {
    // After stripping the leading chdir, the rest has another operator.
    expect(isGitPushInvocation("cd /repo && git status && git push")).toBe(false);
  });

  test("rejects `git push -n` (short alias for --dry-run)", () => {
    expect(isGitPushInvocation("git push -n")).toBe(false);
  });

  test("rejects bundled short flags containing -n (e.g. -fn, -nv)", () => {
    expect(isGitPushInvocation("git push -fn")).toBe(false);
    expect(isGitPushInvocation("git push -nv")).toBe(false);
    expect(isGitPushInvocation("git push -nfu origin main")).toBe(false);
  });

  test("accepts short flags WITHOUT -n", () => {
    expect(isGitPushInvocation("git push -f")).toBe(true);
    expect(isGitPushInvocation("git push -u origin main")).toBe(true);
    expect(isGitPushInvocation("git push -v")).toBe(true);
  });
});

describe("buildOnPushReminder", () => {
  test("always-fire policy: tells the agent to invoke skills now", () => {
    const out = buildOnPushReminder(["review"], "always-fire");
    expect(out).toContain("autoReview.trigger=on-push");
    expect(out).toContain("/review");
    expect(out).toContain("Invoke the required review skill");
    expect(out).not.toContain("Decide:");
  });

  test("always-fire with multiple skills uses plural and joins with commas", () => {
    const out = buildOnPushReminder(["review", "security-review"], "always-fire");
    expect(out).toContain("review skills");
    expect(out).toContain("/review, /security-review");
  });

  test("agent-decides policy: includes the decide block and skip block", () => {
    const out = buildOnPushReminder(["review"], "agent-decides");
    expect(out).toContain("Decide");
    expect(out).toContain("review-worthy changes");
    expect(out).toContain("fixes findings from the most recent review");
    expect(out).toContain("⏭️  Skilled PR auto-review: skipped");
    expect(out).toContain("Be conservative");
  });

  test("agent-decides surfaces the SKIP block verbatim (no markdown wrapping)", () => {
    const out = buildOnPushReminder(["review"], "agent-decides");
    // The skip block should be exactly the 3-line format. Searching for
    // the literal lines tests that they survive any future refactors.
    expect(out).toContain("  ⏭️  Skilled PR auto-review: skipped");
    expect(out).toContain("  Reason: <one sentence - what the recent turns were doing>");
    expect(out).toContain("  To force a fresh review, invoke the review skill manually.");
  });
});

describe("maybeOnPushReminder", () => {
  let tmp: string;
  let prevCwd: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-onpush-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
    mkdirSync(join(tmp, ".skilledpr"));
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeConfig(opts: {
    trigger?: "manual" | "on-push";
    requiredSkills?: string[];
    rules?: Array<{ match: Array<{ branch?: string }>; requiredSkills?: string[] }>;
  }) {
    const trigger = opts.trigger ?? "on-push";
    const skills = opts.requiredSkills ?? ["review"];
    writeFileSync(
      join(tmp, ".skilledpr", "config.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        requiredSkills: skills,
        summaryPrompt: null,
        autoReview: { trigger },
        rules: opts.rules ?? [],
      }),
    );
  }

  test("returns null when event isn't PostToolUse:Bash", async () => {
    writeConfig({ trigger: "on-push" });
    const result = await maybeOnPushReminder({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
    });
    expect(result).toBeNull();
  });

  test("returns null when command isn't a git push", async () => {
    writeConfig({ trigger: "on-push" });
    const result = await maybeOnPushReminder({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    expect(result).toBeNull();
  });

  test("returns null when config doesn't exist", async () => {
    // No config written.
    const result = await maybeOnPushReminder({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    expect(result).toBeNull();
  });

  test("returns null when autoReview.trigger is manual", async () => {
    writeConfig({ trigger: "manual" });
    const result = await maybeOnPushReminder({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    expect(result).toBeNull();
  });

  test("returns null when requiredSkills resolves to empty (bypass)", async () => {
    writeConfig({ trigger: "on-push", requiredSkills: [] });
    const result = await maybeOnPushReminder({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    expect(result).toBeNull();
  });

  test("returns null when a matching rule clears requiredSkills", async () => {
    writeConfig({
      trigger: "on-push",
      requiredSkills: ["review"],
      rules: [{ match: [{ branch: "*" }], requiredSkills: [] }],
    });
    const result = await maybeOnPushReminder({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    expect(result).toBeNull();
  });

  test("uses rule-resolved requiredSkills in the reminder", async () => {
    writeConfig({
      trigger: "on-push",
      requiredSkills: ["review"],
      rules: [{ match: [{ branch: "*" }], requiredSkills: ["review", "security-review"] }],
    });
    const result = await maybeOnPushReminder({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    expect(result).toContain("/review, /security-review");
  });

  test("returns reminder text when all conditions match", async () => {
    writeConfig({ trigger: "on-push", requiredSkills: ["review"] });
    const result = await maybeOnPushReminder({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("git push");
    expect(result).toContain("/review");
  });

  test("returns reminder for chdir-prefixed push", async () => {
    writeConfig({ trigger: "on-push" });
    const result = await maybeOnPushReminder({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cd /repo && git push origin main" },
    });
    expect(result).not.toBeNull();
  });
});
