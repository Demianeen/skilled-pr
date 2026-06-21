import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRequiredContexts,
  diffContexts,
  buildInitialProtectionPayload,
  renderBypassWorkflow,
  writeBypassWorkflow,
  BYPASS_WORKFLOW_PATH,
} from "../src/branch-protection";
import type { RunResult } from "../src/proc";

// ---------------------------------------------------------------------------
// buildRequiredContexts
// ---------------------------------------------------------------------------

describe("buildRequiredContexts", () => {
  test("builds `${statusName} / ${skill}` for each skill", () => {
    const out = buildRequiredContexts(["review", "coderabbit:review"], "Skilled PR");
    expect(out).toEqual(["Skilled PR / review", "Skilled PR / coderabbit:review"]);
  });

  test("preserves order from the skills array", () => {
    const out = buildRequiredContexts(["z", "a", "m"], "Gate");
    expect(out).toEqual(["Gate / z", "Gate / a", "Gate / m"]);
  });

  test("respects custom statusName", () => {
    const out = buildRequiredContexts(["review"], "My Custom Gate");
    expect(out).toEqual(["My Custom Gate / review"]);
  });

  test("empty skills array → empty result (caller should refuse to call)", () => {
    expect(buildRequiredContexts([], "Skilled PR")).toEqual([]);
  });

  test("preserves skill names with colons (plugin-namespaced)", () => {
    expect(buildRequiredContexts(["plugin:skill-name"], "Skilled PR")).toEqual([
      "Skilled PR / plugin:skill-name",
    ]);
  });
});

// ---------------------------------------------------------------------------
// diffContexts
// ---------------------------------------------------------------------------

describe("diffContexts", () => {
  test("no existing contexts → all expected are missing", () => {
    const out = diffContexts([], ["a", "b", "c"]);
    expect(out.missing).toEqual(["a", "b", "c"]);
    expect(out.present).toEqual([]);
  });

  test("all expected present → missing empty, present full", () => {
    const out = diffContexts(["a", "b", "c"], ["a", "b", "c"]);
    expect(out.missing).toEqual([]);
    expect(out.present).toEqual(["a", "b", "c"]);
  });

  test("partial — some present, some missing", () => {
    const out = diffContexts(["a", "x", "b"], ["a", "b", "c"]);
    expect(out.missing).toEqual(["c"]);
    expect(out.present).toEqual(["a", "b"]);
  });

  test("preserves order from `expected` in both outputs (deterministic UI output)", () => {
    const out = diffContexts(["b", "a"], ["a", "b", "c"]);
    expect(out.present).toEqual(["a", "b"]); // not [b, a]
    expect(out.missing).toEqual(["c"]);
  });

  test("ignores existing contexts not in expected (we never touch other tools' checks)", () => {
    const out = diffContexts(["lint", "test", "Skilled PR / review"], ["Skilled PR / review"]);
    expect(out.missing).toEqual([]);
    expect(out.present).toEqual(["Skilled PR / review"]);
    // Implicit invariant: no "extra" field — we don't care about non-Skilled-PR contexts
  });
});

// ---------------------------------------------------------------------------
// buildInitialProtectionPayload
// ---------------------------------------------------------------------------

describe("buildInitialProtectionPayload", () => {
  test("structure matches GitHub's PUT /protection contract", () => {
    const payload = buildInitialProtectionPayload(["Skilled PR / review"]) as {
      required_status_checks: { strict: boolean; contexts: string[] };
      enforce_admins: null;
      required_pull_request_reviews: null;
      restrictions: null;
    };
    expect(payload.required_status_checks.strict).toBe(false);
    expect(payload.required_status_checks.contexts).toEqual(["Skilled PR / review"]);
    expect(payload.enforce_admins).toBeNull();
    expect(payload.required_pull_request_reviews).toBeNull();
    expect(payload.restrictions).toBeNull();
  });

  test("does not include strict: true by default (low friction)", () => {
    const payload = buildInitialProtectionPayload(["a"]) as {
      required_status_checks: { strict: boolean };
    };
    expect(payload.required_status_checks.strict).toBe(false);
  });

  test("contexts come from input, not hardcoded", () => {
    const payload = buildInitialProtectionPayload(["x", "y", "z"]) as {
      required_status_checks: { contexts: string[] };
    };
    expect(payload.required_status_checks.contexts).toEqual(["x", "y", "z"]);
  });

  test("does not mutate the input array (defensive copy)", () => {
    const input = ["a", "b"];
    const payload = buildInitialProtectionPayload(input) as {
      required_status_checks: { contexts: string[] };
    };
    expect(payload.required_status_checks.contexts).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// renderBypassWorkflow + writeBypassWorkflow
// ---------------------------------------------------------------------------

describe("renderBypassWorkflow", () => {
  test("substitutes every occurrence of __SKILLED_PR_VERSION__", () => {
    const template = "v=__SKILLED_PR_VERSION__ also v=__SKILLED_PR_VERSION__";
    expect(renderBypassWorkflow(template, "0.5.0")).toBe("v=0.5.0 also v=0.5.0");
  });

  test("leaves non-placeholder content untouched", () => {
    const template = "name: skilled-pr\nrun: skilled-pr ci-resolve";
    expect(renderBypassWorkflow(template, "1.0.0")).toBe(template);
  });

  test("handles empty version (renders empty pin without crash)", () => {
    expect(renderBypassWorkflow("v=__SKILLED_PR_VERSION__", "")).toBe("v=");
  });
});

describe("writeBypassWorkflow", () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-bypass-wf-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("creates the workflow file when missing", () => {
    expect(existsSync(BYPASS_WORKFLOW_PATH)).toBe(false);
    const result = writeBypassWorkflow();
    expect(result).toBe("created");
    expect(existsSync(BYPASS_WORKFLOW_PATH)).toBe(true);
  });

  test("written file contains a real version pin (not the placeholder)", () => {
    writeBypassWorkflow();
    const content = readFileSync(BYPASS_WORKFLOW_PATH, "utf8");
    expect(content).not.toContain("__SKILLED_PR_VERSION__");
    expect(content).toMatch(/skilled-pr@[\w.-]+/);
  });

  test("idempotent: second call returns 'skipped'", () => {
    writeBypassWorkflow();
    const second = writeBypassWorkflow();
    expect(second).toBe("skipped");
  });

  test("re-renders when existing file content differs", () => {
    // Pre-write a stale workflow file.
    mkdirSync(join(tmp, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(tmp, BYPASS_WORKFLOW_PATH),
      "name: skilled-pr bypass\n# stale content\n",
    );
    const result = writeBypassWorkflow();
    expect(result).toBe("updated");
    const content = readFileSync(BYPASS_WORKFLOW_PATH, "utf8");
    expect(content).toContain("ci-resolve");
  });
});

// ---------------------------------------------------------------------------
// enableGate
// ---------------------------------------------------------------------------

describe("enableGate", () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-enable-gate-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
    mkdirSync(join(tmp, ".skilledpr"), { recursive: true });
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
          rules: [],
        },
        null,
        2,
      ),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/proc");
    vi.resetModules();
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  function ok(stdout = ""): RunResult {
    return { stdout, stderr: "", exitCode: 0 };
  }

  function fail(stderr = "not found"): RunResult {
    return { stdout: "", stderr, exitCode: 1 };
  }

  function mockRunWithExistingContexts(contexts: string[] | null) {
    return vi.fn((args: string[], stdin?: string): RunResult => {
      void stdin;
      if (args[0] === "git" && args[1] === "remote" && args[2] === "get-url") {
        return ok("git@github.com:Demianeen/skilled-pr.git\n");
      }
      if (args[0] === "gh" && args[1] === "repo" && args[2] === "view") {
        return ok("main\n");
      }
      if (
        args[0] === "gh" &&
        args[1] === "api" &&
        args[2] === "repos/Demianeen/skilled-pr/branches/main/protection/required_status_checks"
      ) {
        return contexts === null ? fail() : ok(JSON.stringify({ contexts }));
      }
      if (
        args[0] === "gh" &&
        args[1] === "api" &&
        args[2] === "repos/Demianeen/skilled-pr/branches/main/protection"
      ) {
        return ok();
      }
      if (
        args[0] === "gh" &&
        args[1] === "api" &&
        args[2] === "repos/Demianeen/skilled-pr/branches/main/protection/required_status_checks/contexts"
      ) {
        return ok();
      }
      throw new Error(`unexpected command: ${JSON.stringify(args)}`);
    });
  }

  async function loadEnableGate(runMock: ReturnType<typeof mockRunWithExistingContexts>) {
    vi.resetModules();
    vi.doMock("../src/proc", () => ({ run: runMock }));
    return import("../src/branch-protection");
  }

  test("writes the bypass workflow after creating branch protection", async () => {
    const runMock = mockRunWithExistingContexts(null);
    const { enableGate } = await loadEnableGate(runMock);

    await enableGate();

    expect(existsSync(BYPASS_WORKFLOW_PATH)).toBe(true);
    const content = readFileSync(BYPASS_WORKFLOW_PATH, "utf8");
    expect(content).toContain("skilled-pr ci-resolve");
    expect(runMock.mock.calls.some(([args]) => args.includes("PUT"))).toBe(true);
  });

  test("writes the bypass workflow when required checks were already configured", async () => {
    const runMock = mockRunWithExistingContexts(["Skilled PR / review"]);
    const { enableGate } = await loadEnableGate(runMock);

    await enableGate();

    expect(existsSync(BYPASS_WORKFLOW_PATH)).toBe(true);
    const content = readFileSync(BYPASS_WORKFLOW_PATH, "utf8");
    expect(content).toContain("skilled-pr ci-resolve");
    expect(runMock.mock.calls.some(([args]) => args.includes("POST"))).toBe(false);
  });
});
