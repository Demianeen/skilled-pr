import { describe, expect, test } from "bun:test";
import {
  classifyBunVersion,
  classifyGhVersion,
  classifyGhAuth,
  classifyGitHubRemote,
  classifySkilledPRConfig,
  classifyClaudeHooks,
  classifyBranchProtection,
  formatCheck,
  formatDoctorReport,
} from "../src/doctor";

// ---------------------------------------------------------------------------
// classifyBunVersion
// ---------------------------------------------------------------------------

describe("classifyBunVersion", () => {
  test("null stdout → fail with install hint", () => {
    const r = classifyBunVersion(null);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("not found on PATH");
    expect(r.fix).toContain("bun.sh/install");
  });

  test("normal version output → pass with version", () => {
    const r = classifyBunVersion("1.3.10\n");
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("1.3.10");
  });

  test("unexpected output → warn", () => {
    const r = classifyBunVersion("not-a-version\n");
    expect(r.status).toBe("warn");
    expect(r.fix).toContain("bun --version");
  });
});

// ---------------------------------------------------------------------------
// classifyGhVersion
// ---------------------------------------------------------------------------

describe("classifyGhVersion", () => {
  test("null stdout → fail with install hint", () => {
    const r = classifyGhVersion(null);
    expect(r.status).toBe("fail");
    expect(r.fix).toContain("cli.github.com");
  });

  test("normal version output → pass with extracted semver", () => {
    const r = classifyGhVersion("gh version 2.45.0 (2024-03-19)\nhttps://github.com/cli/cli\n");
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("2.45.0");
  });

  test("unexpected output → warn", () => {
    const r = classifyGhVersion("something weird\n");
    expect(r.status).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// classifyGhAuth
// ---------------------------------------------------------------------------

describe("classifyGhAuth", () => {
  test("non-zero exit → fail with login hint", () => {
    const r = classifyGhAuth(null, "You are not logged into any GitHub hosts.", 1);
    expect(r.status).toBe("fail");
    expect(r.fix).toBe("gh auth login");
  });

  test("stderr-style success output (gh writes status to stderr) → pass with account name", () => {
    const stderr = [
      "github.com",
      "  ✓ Logged in to github.com account Demianeen (oauth_token)",
      "  - Active account: true",
      "  - Git operations protocol: https",
      "  - Token: gho_************************",
    ].join("\n");
    const r = classifyGhAuth("", stderr, 0);
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("Demianeen");
  });

  test("exit 0 but no parseable account → warn", () => {
    const r = classifyGhAuth("", "something something logged in", 0);
    expect(r.status).toBe("warn");
    expect(r.fix).toBe("gh auth status");
  });

  test("handles dashes in usernames", () => {
    const r = classifyGhAuth("", "  ✓ Logged in to github.com account my-org-bot", 0);
    expect(r.detail).toBe("my-org-bot");
  });
});

// ---------------------------------------------------------------------------
// classifyGitHubRemote
// ---------------------------------------------------------------------------

describe("classifyGitHubRemote", () => {
  test("null → fail with add-remote hint", () => {
    const r = classifyGitHubRemote(null);
    expect(r.status).toBe("fail");
    expect(r.fix).toContain("git remote add origin");
  });

  test("GitHub URL → pass with owner/repo", () => {
    const r = classifyGitHubRemote("git@github.com:Demianeen/skilled-pr.git\n");
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("Demianeen/skilled-pr");
  });

  test("non-GitHub URL → fail", () => {
    const r = classifyGitHubRemote("https://gitlab.com/foo/bar.git\n");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("not a GitHub URL");
    expect(r.fix).toContain("GitHub only");
  });
});

// ---------------------------------------------------------------------------
// classifySkilledPRConfig
// ---------------------------------------------------------------------------

describe("classifySkilledPRConfig", () => {
  test("null → fail with init hint", () => {
    const r = classifySkilledPRConfig(null);
    expect(r.status).toBe("fail");
    expect(r.fix).toBe("skilled-pr init");
  });

  test("valid config → pass with requiredSkills summary", () => {
    const r = classifySkilledPRConfig('{ "requiredSkills": ["review", "coderabbit:review"] }');
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("review");
    expect(r.detail).toContain("coderabbit:review");
  });

  test("empty requiredSkills → warn (hook never fires)", () => {
    const r = classifySkilledPRConfig('{ "requiredSkills": [] }');
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("empty");
    expect(r.fix).toContain("at least one skill");
  });

  test("invalid JSON → fail with parse error", () => {
    const r = classifySkilledPRConfig('{ not valid }');
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("parse error");
  });

  test("legacy `sha` field (migration) → fail with migration message", () => {
    const r = classifySkilledPRConfig('{ "requiredSkills": ["review"], "sha": "head" }');
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("sha");
  });
});

// ---------------------------------------------------------------------------
// classifyClaudeHooks
// ---------------------------------------------------------------------------

describe("classifyClaudeHooks", () => {
  test("null → fail with init hint", () => {
    const r = classifyClaudeHooks(null);
    expect(r.status).toBe("fail");
    expect(r.fix).toBe("skilled-pr init");
  });

  test("invalid JSON → fail", () => {
    const r = classifyClaudeHooks("{ not valid }");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("not valid JSON");
  });

  test("non-object top-level → fail", () => {
    const r = classifyClaudeHooks("[]");
    expect(r.status).toBe("fail");
  });

  test("no hooks block at all → fail", () => {
    const r = classifyClaudeHooks('{ "env": { "FOO": "bar" } }');
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("no hooks");
  });

  test("both PostToolUse and UserPromptExpansion installed → pass", () => {
    const settings = JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Skill", hooks: [{ type: "command", command: "skilled-pr hook" }] },
        ],
        UserPromptExpansion: [
          { matcher: "", hooks: [{ type: "command", command: "skilled-pr hook" }] },
        ],
      },
    });
    const r = classifyClaudeHooks(settings);
    expect(r.status).toBe("pass");
  });

  test("only PostToolUse installed → warn (slash-command path missing)", () => {
    const settings = JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Skill", hooks: [{ type: "command", command: "skilled-pr hook" }] },
        ],
      },
    });
    const r = classifyClaudeHooks(settings);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("UserPromptExpansion");
  });

  test("only UserPromptExpansion installed → warn", () => {
    const settings = JSON.stringify({
      hooks: {
        UserPromptExpansion: [
          { matcher: "", hooks: [{ type: "command", command: "skilled-pr hook" }] },
        ],
      },
    });
    const r = classifyClaudeHooks(settings);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("PostToolUse");
  });

  test("hooks block exists but no skilled-pr commands → fail", () => {
    const settings = JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "prettier --write" }] },
        ],
      },
    });
    const r = classifyClaudeHooks(settings);
    expect(r.status).toBe("fail");
  });

  test("tolerates JSONC comments (some users keep them)", () => {
    const settings = `{
      // skilled-pr's hooks
      "hooks": {
        "PostToolUse": [{ "matcher": "Skill", "hooks": [{ "type": "command", "command": "skilled-pr hook" }] }],
        "UserPromptExpansion": [{ "matcher": "", "hooks": [{ "type": "command", "command": "skilled-pr hook" }] }]
      }
    }`;
    const r = classifyClaudeHooks(settings);
    expect(r.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// classifyBranchProtection
// ---------------------------------------------------------------------------

describe("classifyBranchProtection", () => {
  test("non-zero exit (no protection) → warn", () => {
    const r = classifyBranchProtection(null, 1, "Skilled PR");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("no protection");
  });

  test("malformed response → warn", () => {
    const r = classifyBranchProtection("not json", 0, "Skilled PR");
    expect(r.status).toBe("warn");
  });

  test("protection exists but no Skilled PR check → warn", () => {
    const response = JSON.stringify({
      required_status_checks: { contexts: ["lint", "test"] },
    });
    const r = classifyBranchProtection(response, 0, "Skilled PR");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("no required check matches");
  });

  test("protection exists with matching Skilled PR / review check → pass", () => {
    const response = JSON.stringify({
      required_status_checks: { contexts: ["Skilled PR / review", "lint"] },
    });
    const r = classifyBranchProtection(response, 0, "Skilled PR");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("Skilled PR / review");
  });

  test("multiple Skilled PR checks (multiple required skills) → pass with count", () => {
    const response = JSON.stringify({
      required_status_checks: {
        contexts: ["Skilled PR / review", "Skilled PR / coderabbit:review"],
      },
    });
    const r = classifyBranchProtection(response, 0, "Skilled PR");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("2 required check(s)");
  });

  test("custom statusName respected", () => {
    const response = JSON.stringify({
      required_status_checks: { contexts: ["My Custom Gate / review"] },
    });
    const r = classifyBranchProtection(response, 0, "My Custom Gate");
    expect(r.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// formatCheck + formatDoctorReport
// ---------------------------------------------------------------------------

describe("formatCheck", () => {
  test("pass status shows ✓ and no fix line", () => {
    const line = formatCheck(
      { name: "test", status: "pass", detail: "all good", fix: "(never shown)" },
      false,
    );
    expect(line).toContain("✓");
    expect(line).toContain("all good");
    expect(line).not.toContain("Fix:");
    expect(line).not.toContain("(never shown)");
  });

  test("fail status shows ✗ and includes Fix: line", () => {
    const line = formatCheck(
      { name: "test", status: "fail", detail: "broken", fix: "do this" },
      false,
    );
    expect(line).toContain("✗");
    expect(line).toContain("broken");
    expect(line).toContain("Fix: do this");
  });

  test("warn shows ⚠ + fix line", () => {
    const line = formatCheck(
      { name: "test", status: "warn", detail: "minor", fix: "consider X" },
      false,
    );
    expect(line).toContain("⚠");
    expect(line).toContain("Fix: consider X");
  });

  test("skip shows · and no fix line", () => {
    const line = formatCheck({ name: "test", status: "skip", detail: "n/a" }, false);
    expect(line).toContain("·");
    expect(line).not.toContain("Fix:");
  });

  test("useColor=true wraps icon in ANSI escape", () => {
    const line = formatCheck({ name: "test", status: "pass", detail: "ok" }, true);
    expect(line).toContain("\x1b[32m");
    expect(line).toContain("\x1b[0m");
  });
});

describe("formatDoctorReport", () => {
  test("all pass → 'All checks passed' summary", () => {
    const out = formatDoctorReport(
      [
        { name: "a", status: "pass", detail: "ok" },
        { name: "b", status: "pass", detail: "ok" },
      ],
      false,
    );
    expect(out).toContain("All checks passed (2/2)");
  });

  test("mixed → pass/warn/fail summary", () => {
    const out = formatDoctorReport(
      [
        { name: "a", status: "pass", detail: "ok" },
        { name: "b", status: "warn", detail: "meh", fix: "x" },
        { name: "c", status: "fail", detail: "no", fix: "y" },
      ],
      false,
    );
    expect(out).toContain("1/3 pass, 1 warn, 1 fail");
  });

  test("empty → zero-count summary", () => {
    const out = formatDoctorReport([], false);
    expect(out).toContain("0/0");
  });
});
