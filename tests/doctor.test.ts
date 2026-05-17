import { describe, expect, test } from "vitest";
import {
  classifyNodeVersion,
  classifyGhVersion,
  classifyGhAuth,
  classifyGitHubRemote,
  classifySkilledPRConfig,
  classifyClaudeHooks,
  classifyCodexHooks,
  classifyBranchProtection,
  formatCheck,
  formatDoctorReport,
} from "../src/doctor";

// ---------------------------------------------------------------------------
// classifyNodeVersion
// ---------------------------------------------------------------------------

describe("classifyNodeVersion", () => {
  test("null stdout → fail with install hint", () => {
    const r = classifyNodeVersion(null);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("not found on PATH");
    expect(r.fix).toContain("nodejs.org");
  });

  test("v22+ (v-prefixed) → pass with version", () => {
    // `node --version` prints "vX.Y.Z\n" - verify we keep the `v` in detail.
    const r = classifyNodeVersion("v22.11.0\n");
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("v22.11.0");
  });

  test("bare semver (forward-compat) at v22+ → pass", () => {
    // Defensive: if a Node-compatible runtime ever drops the `v` prefix,
    // we still accept it.
    const r = classifyNodeVersion("22.11.0\n");
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("22.11.0");
  });

  test("v24 (newer LTS) → pass", () => {
    // Forward-compat: anything above the floor passes.
    const r = classifyNodeVersion("v24.0.0\n");
    expect(r.status).toBe("pass");
  });

  test("v20 (below required floor) → fail with upgrade hint", () => {
    // engines.node is >=22, and tsup targets node22, so anything below 22
    // will SyntaxError at runtime. The doctor must catch this explicitly;
    // otherwise we report "green" then crash on first invocation.
    const r = classifyNodeVersion("v20.11.0\n");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("v20.11.0");
    expect(r.detail).toContain("below required");
    expect(r.fix).toContain("nvm install 22");
  });

  test("v18 (older EOL'd LTS) → fail", () => {
    const r = classifyNodeVersion("v18.20.0\n");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("below required");
  });

  test("unexpected output → warn", () => {
    const r = classifyNodeVersion("not-a-version\n");
    expect(r.status).toBe("warn");
    expect(r.fix).toContain("node --version");
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
// classifyCodexHooks
// ---------------------------------------------------------------------------

describe("classifyCodexHooks", () => {
  test("null → fail with init hint", () => {
    const r = classifyCodexHooks(null);
    expect(r.status).toBe("fail");
    expect(r.fix).toContain("--for codex");
  });

  test("invalid JSON → fail", () => {
    const r = classifyCodexHooks("{ not valid }");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("not valid JSON");
  });

  test("non-object top-level → fail", () => {
    const r = classifyCodexHooks("[]");
    expect(r.status).toBe("fail");
  });

  test("no hooks array → fail", () => {
    const r = classifyCodexHooks('{ "models": {} }');
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("no hooks array");
  });

  test("UserPromptSubmit + skilled-pr hook installed → pass", () => {
    const settings = JSON.stringify({
      hooks: [{ event: "UserPromptSubmit", command: "skilled-pr hook" }],
    });
    const r = classifyCodexHooks(settings);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("UserPromptSubmit");
  });

  test("hooks array exists but no skilled-pr command → fail", () => {
    const settings = JSON.stringify({
      hooks: [{ event: "SessionStart", command: "/usr/local/bin/notify" }],
    });
    const r = classifyCodexHooks(settings);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("not found");
  });

  test("wrong event but right command → fail", () => {
    // skilled-pr hook on PostToolUse won't fire for Codex skills since
    // Codex doesn't surface them as tool calls. Must be UserPromptSubmit.
    const settings = JSON.stringify({
      hooks: [{ event: "PostToolUse", command: "skilled-pr hook" }],
    });
    const r = classifyCodexHooks(settings);
    expect(r.status).toBe("fail");
  });

  test("tolerates JSONC comments", () => {
    const settings = `{
      // skilled-pr Codex hook
      "hooks": [
        { "event": "UserPromptSubmit", "command": "skilled-pr hook" }
      ]
    }`;
    const r = classifyCodexHooks(settings);
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

// ---------------------------------------------------------------------------
// --why / verbose mode
// ---------------------------------------------------------------------------

describe("classifiers populate `why` for every status branch", () => {
  // Every classifier exposes an educational `why` field. Verified on a
  // representative pass + fail/warn case per classifier so we don't ship a
  // branch without it.

  test("classifyNodeVersion has why on pass + fail", () => {
    expect(classifyNodeVersion("v22.11.0").why).toBeDefined(); // pass
    expect(classifyNodeVersion("v20.11.0").why).toBeDefined(); // fail (below floor)
    expect(classifyNodeVersion(null).why).toBeDefined(); // fail (not found)
  });

  test("classifyGhVersion has why on pass + fail", () => {
    expect(classifyGhVersion("gh version 2.45.0 (2024)").why).toBeDefined();
    expect(classifyGhVersion(null).why).toBeDefined();
  });

  test("classifyGhAuth has why on pass + fail + warn", () => {
    const pass = classifyGhAuth("", "✓ Logged in to github.com account x", 0);
    expect(pass.why).toBeDefined();
    expect(classifyGhAuth(null, "not signed in", 1).why).toBeDefined();
    expect(classifyGhAuth("", "ambiguous", 0).why).toBeDefined();
  });

  test("classifyGitHubRemote has why on pass + fail", () => {
    expect(classifyGitHubRemote("git@github.com:o/r.git").why).toBeDefined();
    expect(classifyGitHubRemote(null).why).toBeDefined();
    expect(classifyGitHubRemote("https://gitlab.com/x/y").why).toBeDefined();
  });

  test("classifySkilledPRConfig has why on pass + warn + fail", () => {
    expect(classifySkilledPRConfig('{ "requiredSkills": ["a"] }').why).toBeDefined();
    expect(classifySkilledPRConfig('{ "requiredSkills": [] }').why).toBeDefined();
    expect(classifySkilledPRConfig(null).why).toBeDefined();
    expect(classifySkilledPRConfig("{ broken }").why).toBeDefined();
  });

  test("classifyClaudeHooks has why on pass + warn + fail variants", () => {
    const both = JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: "skilled-pr hook" }] }],
        UserPromptExpansion: [{ matcher: "", hooks: [{ type: "command", command: "skilled-pr hook" }] }],
      },
    });
    expect(classifyClaudeHooks(both).why).toBeDefined();
    expect(classifyClaudeHooks(null).why).toBeDefined();
    expect(classifyClaudeHooks("{ broken }").why).toBeDefined();
    const partial = JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: "skilled-pr hook" }] }],
      },
    });
    expect(classifyClaudeHooks(partial).why).toBeDefined();
  });

  test("classifyBranchProtection has why on pass + warn", () => {
    const protectedResponse = JSON.stringify({
      required_status_checks: { contexts: ["Skilled PR / review"] },
    });
    expect(classifyBranchProtection(protectedResponse, 0, "Skilled PR").why).toBeDefined();
    expect(classifyBranchProtection(null, 1, "Skilled PR").why).toBeDefined();
  });
});

describe("formatCheck verbose mode", () => {
  const sampleResult = {
    name: "test",
    status: "pass" as const,
    detail: "ok",
    why: "this is why it matters",
  };

  test("verbose=false omits the Why line", () => {
    const out = formatCheck(sampleResult, false, false);
    expect(out).not.toContain("Why:");
    expect(out).not.toContain("why it matters");
  });

  test("verbose=true includes the Why line", () => {
    const out = formatCheck(sampleResult, false, true);
    expect(out).toContain("Why:");
    expect(out).toContain("why it matters");
  });

  test("verbose defaults to false (backwards compatible)", () => {
    // Old call sites that didn't pass verbose should still work and stay quiet.
    const out = formatCheck(sampleResult, false);
    expect(out).not.toContain("Why:");
  });

  test("verbose=true on a check without a why field is a no-op (graceful)", () => {
    const noWhy = { name: "x", status: "pass" as const, detail: "ok" };
    const out = formatCheck(noWhy, false, true);
    expect(out).not.toContain("Why:");
    expect(out).toContain("ok");
  });

  test("verbose=true with fail status shows both Fix and Why", () => {
    const out = formatCheck(
      { name: "x", status: "fail", detail: "broken", fix: "do this", why: "matters because Y" },
      false,
      true,
    );
    expect(out).toContain("Fix: do this");
    expect(out).toContain("Why: matters because Y");
  });

  test("wraps long why text instead of one-lining", () => {
    const longWhy =
      "this is a very long explanation that should definitely be wrapped at around seventy two columns because terminal output that doesn't wrap is hard to read and you'd hate it";
    const out = formatCheck(
      { name: "x", status: "pass", detail: "ok", why: longWhy },
      false,
      true,
    );
    // The wrapper inserts newlines + indent
    const whyBlock = out.split("Why: ")[1];
    expect(whyBlock).toContain("\n       "); // 7-space continuation indent
  });
});

describe("formatDoctorReport tip line", () => {
  const results = [
    { name: "a", status: "pass" as const, detail: "ok", why: "matters" },
    { name: "b", status: "pass" as const, detail: "ok", why: "matters" },
  ];

  test("verbose=false includes the --why tip (discoverability)", () => {
    const out = formatDoctorReport(results, false, false);
    expect(out).toContain("skilled-pr doctor --why");
    expect(out).toContain("what each check is for");
  });

  test("verbose=true omits the tip (user already knows)", () => {
    const out = formatDoctorReport(results, false, true);
    expect(out).not.toContain("--why");
    expect(out).not.toContain("Tip:");
  });

  test("verbose defaults to false (backwards compatible)", () => {
    const out = formatDoctorReport(results, false);
    expect(out).toContain("skilled-pr doctor --why");
  });

  test("tip appears below the summary line", () => {
    const out = formatDoctorReport(results, false, false);
    const summaryIdx = out.indexOf("All checks passed");
    const tipIdx = out.indexOf("Tip:");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(tipIdx).toBeGreaterThan(summaryIdx);
  });
});
