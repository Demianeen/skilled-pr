import { describe, expect, test } from "vitest";
import {
  classifyNodeVersion,
  classifyGhVersion,
  classifyGhAuth,
  classifyGitHubRemote,
  classifySkilledPRConfig,
  classifySchemaVersion,
  classifyBundledSchema,
  classifyRulePatterns,
  classifyReferencedSkills,
  classifyClaudeHooks,
  classifyCodexVersion,
  classifyCodexHooks,
  classifyBranchProtection,
  formatCheck,
  formatDoctorReport,
} from "../src/doctor";
import { CURRENT_SCHEMA_VERSION, type SkilledPRConfig } from "../src/config";

function baseConfig(overrides: Partial<SkilledPRConfig> = {}): SkilledPRConfig {
  return {
    schemaVersion: 1,
    requiredSkills: ["review"],
    statusName: "Skilled PR",
    failOn: "error",
    summaryPrompt: null,
    briefingPrompt: null,
    autoReview: {
      trigger: "manual",
      execution: "main-agent",
      sessionBriefing: false,
      skipPolicy: "agent-decides",
    },
    rules: [],
    ...overrides,
  };
}

const SV = `"schemaVersion": ${CURRENT_SCHEMA_VERSION}`;

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

  test("valid v1 config → pass with requiredSkills summary", () => {
    const r = classifySkilledPRConfig(
      `{ ${SV}, "requiredSkills": ["review", "coderabbit:review"] }`,
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("review");
    expect(r.detail).toContain("coderabbit:review");
  });

  test("empty requiredSkills → warn (hook never fires)", () => {
    const r = classifySkilledPRConfig(`{ ${SV}, "requiredSkills": [] }`);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("empty");
    expect(r.fix).toContain("at least one skill");
  });

  test("missing schemaVersion → fail with migration hint", () => {
    // Old configs without schemaVersion don't parse. doctor surfaces
    // that as a fail-with-fix; classifySchemaVersion adds a separate
    // line for newer/older drift.
    const r = classifySkilledPRConfig('{ "requiredSkills": ["review"] }');
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("schemaVersion");
  });

  test("invalid JSON → fail with parse error", () => {
    const r = classifySkilledPRConfig('{ not valid }');
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("parse error");
  });

  test("legacy `sha` field (migration) → fail with migration message", () => {
    const r = classifySkilledPRConfig(`{ ${SV}, "requiredSkills": ["review"], "sha": "head" }`);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("sha");
  });

  test("legacy .skilledpr.jsonc at root → fail with migration hint", () => {
    // doctor probes both paths and passes a `legacyExists` flag.
    const r = classifySkilledPRConfig(null, true);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain(".skilledpr.jsonc");
    expect(r.fix).toContain(".skilledpr/config.jsonc");
    expect(r.fix).toMatch(/migrator|skilled-pr init/i);
  });
});

// ---------------------------------------------------------------------------
// classifySchemaVersion (new in v1)
// ---------------------------------------------------------------------------

describe("classifySchemaVersion", () => {
  test("null config → skip (no config to check)", () => {
    expect(classifySchemaVersion(null).status).toBe("skip");
  });

  test("schemaVersion matches CURRENT_SCHEMA_VERSION → pass", () => {
    const r = classifySchemaVersion(baseConfig());
    expect(r.status).toBe("pass");
    expect(r.detail).toContain(`v${CURRENT_SCHEMA_VERSION}`);
  });

  test("schemaVersion newer than CLI → fail with upgrade hint", () => {
    // Cast through any because the type says exactly v1; the
    // classifier still needs to handle drift defensively.
    const cfg = { ...baseConfig(), schemaVersion: 2 as any };
    const r = classifySchemaVersion(cfg);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("CLI only supports");
    expect(r.fix).toMatch(/upgrade/i);
  });

  test("schemaVersion older than CLI → warn with migration hint", () => {
    const cfg = { ...baseConfig(), schemaVersion: 0 as any };
    const r = classifySchemaVersion(cfg);
    expect(r.status).toBe("warn");
    expect(r.fix).toMatch(/skilled-pr-update|skilled-pr init/);
  });
});

// ---------------------------------------------------------------------------
// classifyBundledSchema (new in v1)
// ---------------------------------------------------------------------------

describe("classifyBundledSchema", () => {
  test("identical content → pass", () => {
    const r = classifyBundledSchema("{ \"x\": 1 }", "{ \"x\": 1 }");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("matches");
  });

  test("repo missing → warn with init hint", () => {
    const r = classifyBundledSchema(null, "{ \"x\": 1 }");
    expect(r.status).toBe("warn");
    expect(r.fix).toContain("skilled-pr init");
  });

  test("CLI bundle missing → warn (reinstall hint)", () => {
    const r = classifyBundledSchema("{ \"x\": 1 }", null);
    expect(r.status).toBe("warn");
    expect(r.fix).toMatch(/reinstall/i);
  });

  test("content drift → warn with refresh hint", () => {
    const r = classifyBundledSchema("{ \"a\": 1 }", "{ \"b\": 2 }");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("drift");
    expect(r.fix).toContain("skilled-pr init");
  });
});

// ---------------------------------------------------------------------------
// classifyRulePatterns (new in v1)
// ---------------------------------------------------------------------------

describe("classifyRulePatterns", () => {
  test("empty rules → pass", () => {
    expect(classifyRulePatterns([]).status).toBe("pass");
  });

  test("valid rules → pass with count", () => {
    const rules = [
      { match: [{ branch: "main" }] },
      { match: [{ branch: "release-*" }, { author: "dependabot[bot]" }] },
    ];
    const r = classifyRulePatterns(rules);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("2 rule(s)");
  });

  test("empty author → fail", () => {
    const r = classifyRulePatterns([{ match: [{ author: "   " }] }]);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("author");
  });

  test("empty label entry → fail", () => {
    const r = classifyRulePatterns([{ match: [{ labels: ["security", ""] }] }]);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("labels");
  });

  test("branch with metacharacters (no regex injection) → pass", () => {
    // The patterns are translated to anchored regex; metachars in the
    // pattern must be escaped before compilation. Verifying that
    // edge case here protects against a regression where someone
    // pipes user input through unchanged.
    const r = classifyRulePatterns([{ match: [{ branch: "release/v1.0.0" }] }]);
    expect(r.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// classifyReferencedSkills (new in v1)
// ---------------------------------------------------------------------------

describe("classifyReferencedSkills", () => {
  test("no skills referenced → skip", () => {
    const r = classifyReferencedSkills([], [], ["review"], null);
    expect(r.status).toBe("skip");
  });

  test("no harness skill dirs → skip", () => {
    const r = classifyReferencedSkills([], ["review"], null, null);
    expect(r.status).toBe("skip");
  });

  test("all skills found in claude dir → pass", () => {
    const r = classifyReferencedSkills([], ["review"], ["review"], null);
    expect(r.status).toBe("pass");
  });

  test("namespaced skill matched by bare name in skill dir → pass", () => {
    // The Codex/Claude skills dir lists `review` (bare); the config
    // says `coderabbit:review` (namespaced). The classifier accepts
    // a match on the bare segment after the colon.
    const r = classifyReferencedSkills([], ["coderabbit:review"], ["review"], null);
    expect(r.status).toBe("pass");
  });

  test("skill not found anywhere → warn with missing list", () => {
    const r = classifyReferencedSkills([], ["typo-review"], ["review"], ["cso"]);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("typo-review");
  });

  test("rule.requiredSkills are also checked", () => {
    const rules = [
      {
        match: [{ branch: "release-*" }],
        requiredSkills: ["nonexistent-skill"],
      },
    ];
    const r = classifyReferencedSkills(rules, ["review"], ["review"], null);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("nonexistent-skill");
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
// classifyCodexVersion
// ---------------------------------------------------------------------------

describe("classifyCodexVersion", () => {
  test("null stdout (binary missing) -> fail with install hint", () => {
    const r = classifyCodexVersion(null);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("not found on PATH");
    expect(r.fix).toContain("Install Codex CLI");
  });

  test("any non-empty version line -> pass with stdout verbatim", () => {
    // Codex's --version output format is not stable across builds, so we
    // accept whatever it prints (parsing for a specific pattern would
    // false-fail when Codex changes its banner).
    const r = classifyCodexVersion("codex 0.42.1 (commit abc123)\nhttps://openai.com/codex\n");
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("codex 0.42.1 (commit abc123)");
  });

  test("bare semver output -> pass (forward-compat)", () => {
    const r = classifyCodexVersion("0.42.1\n");
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("0.42.1");
  });

  test("empty / whitespace-only stdout -> warn", () => {
    const r = classifyCodexVersion("\n\n  \n");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("empty");
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
    expect(
      classifySkilledPRConfig(`{ ${SV}, "requiredSkills": ["a"] }`).why,
    ).toBeDefined();
    expect(
      classifySkilledPRConfig(`{ ${SV}, "requiredSkills": [] }`).why,
    ).toBeDefined();
    expect(classifySkilledPRConfig(null).why).toBeDefined();
    expect(classifySkilledPRConfig("{ broken }").why).toBeDefined();
    expect(classifySkilledPRConfig(null, true).why).toBeDefined();
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
