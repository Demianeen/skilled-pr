import { describe, expect, test } from "bun:test";
import { parseGitHubRemote, buildStatusContext } from "../src/github";

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
