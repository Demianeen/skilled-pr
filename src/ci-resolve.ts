// skilled-pr ci-resolve
//
// Designed to run inside a GitHub Actions workflow that fires on
// `pull_request` events. Resolves the active rule profile for a specific
// PR and (optionally) posts a status to GitHub on its head SHA.
//
// Used by the bundled `.github/workflows/skilled-pr-bypass.yml` workflow
// that `enable-gate` writes into the user's repo. The flow:
//
//   PR opened/synced → workflow fires → checkout + setup node
//   → `npx skilled-pr@<pinned> ci-resolve --pr N --post`
//   → reads .skilledpr/config.jsonc from the checkout
//   → fetches PR metadata via `gh api`
//   → calls resolveProfile()
//   → if requiredSkills is empty (bypass matched), posts SUCCESS status
//   → otherwise posts PENDING status with a CTA description directing
//     the user to invoke the required review skill
//
// Separates concerns:
//   - `attest`: posts the FINAL status (success/failure) after a review
//     skill ran. Driven by Claude Code / Codex inside the user's session.
//   - `ci-resolve`: posts the INITIAL status (bypass-success or
//     pending+CTA) when the PR opens. Driven by GitHub Actions.
//
// Local debugging: pass `--pr <num>` from your terminal and (optionally)
// `--json` to skip posting and just dump the resolved profile.

import { loadConfig } from "./config";
import { run } from "./proc";
import { parseGitHubRemote, buildStatusContext, classifyGhError } from "./github";
import { resolveProfile, type PRContext, type ResolvedProfile } from "./resolve";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CIResolveArgs {
  ok: true;
  prNumber: number;
  json: boolean;
  post: boolean;
}

interface CIResolveArgsError {
  ok: false;
  error: string;
}

/**
 * Parse `ci-resolve` flags. `--pr <N>` is required; `--json` and `--post`
 * are mutually compatible (you can dump JSON AND post the status, useful
 * for piping logs in CI).
 *
 * Permissive on accepted forms: `--pr 42`, `--pr=42`, but no positional
 * (matches the strict pattern in args.ts).
 */
export function parseCIResolveArgs(argv: ReadonlyArray<string>): CIResolveArgs | CIResolveArgsError {
  let prRaw: string | undefined;
  let json = false;
  let post = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--post") {
      post = true;
      continue;
    }
    if (token === "--pr") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: "--pr requires a value (the PR number)" };
      }
      prRaw = next;
      i++;
      continue;
    }
    if (token.startsWith("--pr=")) {
      const v = token.slice("--pr=".length);
      if (v.length === 0) {
        return { ok: false, error: "--pr= requires a value" };
      }
      prRaw = v;
      continue;
    }
    return { ok: false, error: `unknown argument "${token}"` };
  }

  if (prRaw === undefined) {
    return { ok: false, error: "--pr <number> is required" };
  }
  const prNumber = Number.parseInt(prRaw, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, error: `--pr must be a positive integer (got "${prRaw}")` };
  }

  return { ok: true, prNumber, json, post };
}

// ---------------------------------------------------------------------------
// PR context fetch
// ---------------------------------------------------------------------------

/**
 * Fetch PR metadata via `gh api`. Returns null on any failure (network,
 * 404, malformed response). The caller decides whether to bail or
 * proceed with a partial context.
 *
 * Note: when running inside a GitHub Actions workflow the
 * `GITHUB_EVENT_PATH` env var points at a JSON file with the full event
 * payload. Future optimization: read from that file when present to
 * avoid the extra API call. For v1, the gh call works in both CI and
 * local environments without branching, which keeps the code path
 * uniform.
 */
export function fetchPRContext(prNumber: number): PRContext | null {
  const remote = getRemote();
  if (!remote) return null;
  const result = run([
    "gh",
    "api",
    `repos/${remote.owner}/${remote.repo}/pulls/${prNumber}`,
  ]);
  if (result.exitCode !== 0) return null;
  try {
    const pr = JSON.parse(result.stdout) as {
      head?: { ref?: string; sha?: string };
      user?: { login?: string };
      labels?: Array<{ name?: string }>;
    };
    const branch = pr.head?.ref;
    const sha = pr.head?.sha;
    const author = pr.user?.login;
    const labels = (pr.labels ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    if (typeof branch !== "string" || branch.length === 0) return null;
    return {
      branch,
      sha,
      author,
      labels,
    };
  } catch {
    return null;
  }
}

function getRemote() {
  const result = run(["git", "remote", "get-url", "origin"]);
  if (result.exitCode !== 0) return null;
  return parseGitHubRemote(result.stdout);
}

// ---------------------------------------------------------------------------
// Status posting
// ---------------------------------------------------------------------------

/**
 * Check whether any skilled-pr status check is already posted for this
 * sha + context. If yes, the agent has already attested (or a previous
 * workflow run posted pending); we don't want to overwrite that.
 *
 * Returns the existing status's state, or null if none found.
 */
function existingStatusState(sha: string, context: string): string | null {
  const remote = getRemote();
  if (!remote) return null;
  const result = run([
    "gh",
    "api",
    `repos/${remote.owner}/${remote.repo}/commits/${sha}/statuses`,
  ]);
  if (result.exitCode !== 0) return null;
  try {
    const statuses = JSON.parse(result.stdout) as Array<{ context: string; state: string }>;
    // GH returns most recent first; first match wins.
    const latest = statuses.find((s) => s.context === context);
    return latest?.state ?? null;
  } catch {
    return null;
  }
}

/** Post a commit status. Wraps the gh api call; returns true on success. */
function postStatus(
  sha: string,
  context: string,
  state: "success" | "pending",
  description: string,
): boolean {
  const remote = getRemote();
  if (!remote) return false;
  const result = run([
    "gh",
    "api",
    `repos/${remote.owner}/${remote.repo}/statuses/${sha}`,
    "-X",
    "POST",
    "-f",
    `state=${state}`,
    "-f",
    `context=${context}`,
    "-f",
    `description=${description}`,
  ]);
  if (result.exitCode !== 0) {
    const classified = classifyGhError(result.stderr, { operation: "post-status", remote });
    console.error(`Skilled PR: failed to post status.\n\n${classified.message}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format the resolved profile + decision for human reading. Used when
 * `--json` is not passed.
 */
export function formatResolution(
  prNumber: number,
  context: PRContext,
  profile: ResolvedProfile,
): string {
  const lines: string[] = [];
  lines.push(`PR #${prNumber}`);
  lines.push(`  branch:  ${context.branch}`);
  if (context.author) lines.push(`  author:  ${context.author}`);
  if (context.labels && context.labels.length > 0) {
    lines.push(`  labels:  ${context.labels.join(", ")}`);
  }
  lines.push("");
  lines.push(`Resolved profile:`);
  if (profile.matchedRuleName !== null) {
    lines.push(`  matched rule:    ${profile.matchedRuleName}`);
  } else {
    lines.push(`  matched rule:    (none — top-level defaults apply)`);
  }
  lines.push(`  requiredSkills:  ${JSON.stringify(profile.requiredSkills)}`);
  lines.push(`  failOn:          ${profile.failOn}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function ciResolve(argv: string[]): Promise<void> {
  const parsed = parseCIResolveArgs(argv);
  if (!parsed.ok) {
    console.error(`Usage: skilled-pr ci-resolve --pr <number> [--json] [--post]\n  (${parsed.error})`);
    process.exit(1);
  }

  const config = await loadConfig();
  if (!config) {
    console.error("Skilled PR: no .skilledpr/config.jsonc found.");
    process.exit(1);
  }

  const context = fetchPRContext(parsed.prNumber);
  if (!context) {
    console.error(`Skilled PR: could not fetch PR #${parsed.prNumber} via gh. Check authentication and PR number.`);
    process.exit(1);
  }

  const profile = resolveProfile(config, context);

  if (parsed.json) {
    console.log(
      JSON.stringify(
        {
          pr: parsed.prNumber,
          context,
          profile,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatResolution(parsed.prNumber, context, profile));
  }

  if (!parsed.post) return;

  // --- Status posting decision tree ----------------------------------------
  //
  // Three cases:
  //   1. requiredSkills is empty       → bypass success
  //   2. existing status is success/failure → don't overwrite; attest owns it
  //   3. otherwise                      → pending + CTA description
  if (!context.sha) {
    console.error("Skilled PR: PR has no head SHA; cannot post status.");
    process.exit(1);
  }

  // For bypass: post per-required-skill OR a single bypass context?
  // We post a single context based on statusName so branch protection
  // can require this exact context. Use the resolved profile's matched
  // rule name (if any) in the description for traceability.
  if (profile.requiredSkills.length === 0) {
    // Bypass — post success against each EXPECTED skill context.
    // Branch protection lists checks by context name; if defaults
    // expected `Skilled PR / review`, the bypass status must also be
    // `Skilled PR / review` (with state=success) to satisfy the gate.
    const expectedContexts = config.requiredSkills.map((s) =>
      buildStatusContext(config.statusName, s),
    );
    const description = profile.matchedRuleName
      ? `Bypass: no review required (matched rule: ${profile.matchedRuleName}).`
      : `Bypass: no review required.`;
    for (const ctx of expectedContexts) {
      const existing = existingStatusState(context.sha, ctx);
      if (existing === "success" || existing === "failure") {
        // Attest already ran for this skill — leave it alone.
        continue;
      }
      postStatus(context.sha, ctx, "success", description);
    }
    console.log(`Skilled PR ✓ bypass status posted on ${context.sha.slice(0, 7)}.`);
    return;
  }

  // Required-skills case: post pending+CTA for each skill that doesn't
  // already have a status. attest will replace these later.
  const skillsNeedingCTA = profile.requiredSkills.filter((skill) => {
    const ctx = buildStatusContext(config.statusName, skill);
    const existing = existingStatusState(context.sha!, ctx);
    return existing !== "success" && existing !== "failure";
  });
  if (skillsNeedingCTA.length === 0) {
    console.log(`Skilled PR: all required skill statuses already posted on ${context.sha.slice(0, 7)}.`);
    return;
  }
  for (const skill of skillsNeedingCTA) {
    const ctx = buildStatusContext(config.statusName, skill);
    const description = `Invoke /${skill} in Claude Code or Codex to complete this gate.`;
    postStatus(context.sha, ctx, "pending", description);
  }
  console.log(
    `Skilled PR: posted ${skillsNeedingCTA.length} pending status(es) with CTAs on ${context.sha.slice(0, 7)}.`,
  );
}
