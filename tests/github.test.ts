import { describe, expect, test } from "vitest";
import { parseGitHubRemote, buildStatusContext, classifyGhError } from "../src/github";

describe("parseGitHubRemote", () => {
  test("parses HTTPS URL", () => {
    expect(parseGitHubRemote("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses HTTPS URL without .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses SSH URL", () => {
    expect(parseGitHubRemote("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses SSH URL without .git suffix", () => {
    expect(parseGitHubRemote("git@github.com:owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("tolerates trailing newline from git remote output", () => {
    expect(parseGitHubRemote("git@github.com:foo/bar.git\n")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  test("tolerates trailing slash", () => {
    expect(parseGitHubRemote("https://github.com/foo/bar/")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  test("handles repo names with dots and dashes", () => {
    expect(parseGitHubRemote("https://github.com/my-org/repo.name.git")).toEqual({
      owner: "my-org",
      repo: "repo.name",
    });
  });

  test("returns null for non-GitHub URLs", () => {
    expect(parseGitHubRemote("https://gitlab.com/owner/repo.git")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseGitHubRemote("")).toBeNull();
  });

  test("returns null for garbage input", () => {
    expect(parseGitHubRemote("not-a-url")).toBeNull();
  });
});

describe("buildStatusContext", () => {
  test("combines status name and skill with separator", () => {
    expect(buildStatusContext("Skilled PR", "review")).toBe("Skilled PR / review");
  });

  test("preserves skill names with colons (e.g. coderabbit:review)", () => {
    expect(buildStatusContext("Skilled PR", "coderabbit:review")).toBe(
      "Skilled PR / coderabbit:review",
    );
  });
});

// ---------------------------------------------------------------------------
// classifyGhError
// ---------------------------------------------------------------------------

describe("classifyGhError", () => {
  const REMOTE = { owner: "Demianeen", repo: "skilled-pr" };

  test("parses HTTP status from gh's `(HTTP NNN)` suffix", () => {
    const c = classifyGhError("gh: Not Found (HTTP 404)", { operation: "post-status" });
    expect(c.httpStatus).toBe(404);
  });

  test("returns null httpStatus when stderr has no HTTP code", () => {
    const c = classifyGhError("connection refused", { operation: "post-status" });
    expect(c.httpStatus).toBeNull();
  });

  // ----- 404 on writes — the headline case for this commit -----

  test("404 on post-status → write-access hint with gh auth status/switch/refresh commands", () => {
    const c = classifyGhError("gh: Not Found (HTTP 404)", {
      operation: "post-status",
      remote: REMOTE,
    });
    expect(c.isNotFound).toBe(true);
    expect(c.isAuth).toBe(false);
    expect(c.message).toContain("404");
    expect(c.message).toContain("lacks write access");
    expect(c.message).toContain("Demianeen/skilled-pr");
    expect(c.message).toContain("gh auth status");
    expect(c.message).toContain("gh auth switch");
    expect(c.message).toContain("gh auth refresh -s repo");
  });

  test("404 on post-comment uses the same write-access hint", () => {
    const c = classifyGhError("gh: Not Found (HTTP 404)", {
      operation: "post-comment",
      remote: REMOTE,
    });
    expect(c.message).toContain("post-comment");
    expect(c.message).toContain("lacks write access");
  });

  test("404 on edit-comment uses the same write-access hint", () => {
    const c = classifyGhError("gh: Not Found (HTTP 404)", {
      operation: "edit-comment",
      remote: REMOTE,
    });
    expect(c.message).toContain("lacks write access");
  });

  // ----- 404 on reads is different — could be wrong-repo or wrong-account -----

  test("404 on fetch-pulls suggests verifying remote URL + auth account", () => {
    const c = classifyGhError("gh: Not Found (HTTP 404)", {
      operation: "fetch-pulls",
      remote: REMOTE,
    });
    expect(c.isNotFound).toBe(true);
    expect(c.message).not.toContain("lacks write access");
    expect(c.message).toContain("git remote get-url origin");
    expect(c.message).toContain("gh auth status");
  });

  // ----- Auth -----

  test("HTTP 401 → auth hint", () => {
    const c = classifyGhError("gh: Unauthorized (HTTP 401)", { operation: "post-status" });
    expect(c.isAuth).toBe(true);
    expect(c.message).toContain("not authenticated");
    expect(c.message).toContain("gh auth login");
  });

  test("gh's own 'not authenticated' text (no HTTP code) → auth hint", () => {
    const c = classifyGhError("error: not authenticated, run 'gh auth login'", {
      operation: "post-status",
    });
    expect(c.isAuth).toBe(true);
    expect(c.httpStatus).toBeNull();
    expect(c.message).toContain("gh auth login");
  });

  test("bad credentials → auth", () => {
    const c = classifyGhError("Bad credentials (HTTP 401)", { operation: "fetch-status" });
    expect(c.isAuth).toBe(true);
  });

  // ----- Rate limit -----

  test("rate-limit-flavored 403 → rate-limit message (NOT auth)", () => {
    const c = classifyGhError("API rate limit exceeded (HTTP 403)", {
      operation: "fetch-comments",
    });
    expect(c.isRateLimit).toBe(true);
    expect(c.isAuth).toBe(false);
    expect(c.message).toContain("rate limit");
    expect(c.message).not.toContain("gh auth login");
  });

  test("rate limit wins over 'Not Found' if both appear (defensive)", () => {
    const c = classifyGhError("rate limit exceeded — Not Found", { operation: "post-status" });
    expect(c.isRateLimit).toBe(true);
    expect(c.isNotFound).toBe(false);
  });

  // ----- Fallbacks -----

  test("unknown HTTP code falls back to generic with status + stderr", () => {
    const c = classifyGhError("gh: Internal Server Error (HTTP 500)", {
      operation: "post-status",
    });
    expect(c.httpStatus).toBe(500);
    expect(c.message).toContain("HTTP 500");
    expect(c.message).toContain("Internal Server Error");
  });

  test("no HTTP code at all (network error) falls back to generic", () => {
    const c = classifyGhError("error: could not resolve host github.com", {
      operation: "post-status",
    });
    expect(c.httpStatus).toBeNull();
    expect(c.isAuth).toBe(false);
    expect(c.isNotFound).toBe(false);
    expect(c.message).toContain("gh command failed");
    expect(c.message).toContain("could not resolve host");
  });

  test("uses 'this repo' as fallback when no remote is supplied", () => {
    const c = classifyGhError("gh: Not Found (HTTP 404)", { operation: "post-status" });
    expect(c.message).toContain("this repo");
  });

  test("preserves raw stderr for debugging", () => {
    const original = "some weird gh output (HTTP 999)";
    const c = classifyGhError(original, { operation: "post-status" });
    expect(c.raw).toBe(original);
  });
});
