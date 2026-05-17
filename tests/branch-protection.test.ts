import { describe, expect, test } from "vitest";
import {
  buildRequiredContexts,
  diffContexts,
  buildInitialProtectionPayload,
} from "../src/branch-protection";

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
