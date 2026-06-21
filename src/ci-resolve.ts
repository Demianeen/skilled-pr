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

import { collectAllSkillNames, loadConfig, type SkilledPRConfig } from "./config";
import { run } from "./proc";
import { parseGitHubRemote, buildStatusContext, classifyGhError, type GitHubRemote } from "./github";
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
  if (!/^[1-9]\d*$/.test(prRaw)) {
    return { ok: false, error: `--pr must be a positive integer (got "${prRaw}")` };
  }
  const prNumber = Number(prRaw);
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

export interface ExistingStatus {
  state: string;
  description: string | null;
}

/**
 * Fetch latest statuses for this sha, keyed by context. GitHub returns
 * commit statuses newest first, so the first context match is the one the
 * PR gate currently exposes to users.
 */
function existingStatusesByContext(remote: GitHubRemote, sha: string): Map<string, ExistingStatus> {
  const result = run([
    "gh",
    "api",
    `repos/${remote.owner}/${remote.repo}/commits/${sha}/statuses`,
  ]);
  const byContext = new Map<string, ExistingStatus>();
  if (result.exitCode !== 0) return byContext;
  try {
    const statuses = JSON.parse(result.stdout) as Array<{
      context?: unknown;
      state?: unknown;
      description?: unknown;
    }>;
    for (const status of statuses) {
      if (typeof status.context !== "string" || typeof status.state !== "string") continue;
      if (byContext.has(status.context)) continue;
      byContext.set(status.context, {
        state: status.state,
        description: typeof status.description === "string" ? status.description : null,
      });
    }
    return byContext;
  } catch {
    return byContext;
  }
}

function isCIResolveDescription(description: string | null | undefined): boolean {
  return (
    typeof description === "string" &&
    (description.startsWith("Invoke /") || description.startsWith("Not required for this PR"))
  );
}

/**
 * `ci-resolve` may replace statuses that it previously posted, because
 * labels or branch rules can change for the same commit SHA. It must not
 * replace a real skill attestation, which owns final success/failure.
 */
export function isFinalAttestationStatus(status: ExistingStatus | undefined): boolean {
  if (!status) return false;
  if (status.state !== "success" && status.state !== "failure") return false;
  return !isCIResolveDescription(status.description);
}

/**
 * GitHub rejects commit-status descriptions over 140 chars (422). Rule
 * names are user-supplied and length-unbounded, so clamp every
 * description we compose rather than hoping they stay short.
 */
export function clampDescription(description: string, max = 140): string {
  if (description.length <= max) return description;
  return `${description.slice(0, max - 1)}…`;
}

/**
 * One status ci-resolve intends to post. Produced by `planStatusPosts`
 * (pure); `ciResolve` filters out contexts that already carry a final
 * attestation and POSTs the rest.
 */
export interface StatusPost {
  context: string;
  state: "success" | "pending";
  description: string;
}

/**
 * Decide which statuses to post for one PR.
 *
 * Branch protection requires the UNION of contexts across the config
 * (defaults + every rule's override — see `collectAllSkillNames`), while
 * the resolved profile says which skills THIS PR actually needs. So:
 *
 *   - every skill the profile requires      → pending + CTA (attest
 *     replaces it with the final success/failure)
 *   - every other registrable context       → success, "not required for
 *     this PR" (otherwise branch protection waits forever on a context
 *     nothing will ever post)
 *
 * The old standalone "bypass" branch is the degenerate case: the profile
 * requires nothing, so every context gets the not-required success.
 */
export function planStatusPosts(
  config: SkilledPRConfig,
  profile: ResolvedProfile,
): StatusPost[] {
  const required = new Set(profile.requiredSkills);
  const ruleSuffix = profile.matchedRuleName ? ` (rule: ${profile.matchedRuleName})` : "";
  const posts: StatusPost[] = [];
  for (const skill of collectAllSkillNames(config)) {
    const context = buildStatusContext(config.statusName, skill);
    if (required.has(skill)) {
      posts.push({
        context,
        state: "pending",
        description: clampDescription(
          `Invoke /${skill} in Claude Code or Codex to complete this gate.`,
        ),
      });
    } else {
      posts.push({
        context,
        state: "success",
        description: clampDescription(`Not required for this PR${ruleSuffix}.`),
      });
    }
  }
  return posts;
}

/** Post a commit status. Wraps the gh api call; returns true on success. */
function postStatus(
  remote: GitHubRemote,
  sha: string,
  context: string,
  state: "success" | "pending",
  description: string,
): boolean {
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

  // --- Status posting -------------------------------------------------------
  //
  // `planStatusPosts` decides what every registrable context should say
  // for THIS PR (pending+CTA for required skills, "not required" success
  // for the rest — bypass falls out as the everything-success case). The
  // only runtime filter: a context that already carries a final
  // attestation (success/failure) belongs to attest — never overwrite it.
  if (!context.sha) {
    console.error("Skilled PR: PR has no head SHA; cannot post status.");
    process.exit(1);
  }

  const posts = planStatusPosts(config, profile);
  const remote = getRemote();
  if (!remote) {
    console.error("Skilled PR: no GitHub remote configured for `origin`.");
    process.exit(1);
  }
  const existingByContext = existingStatusesByContext(remote, context.sha);
  let pendingPosted = 0;
  let notRequiredPosted = 0;
  let attested = 0;
  for (const post of posts) {
    const existing = existingByContext.get(post.context);
    if (isFinalAttestationStatus(existing)) {
      attested++;
      continue;
    }
    if (postStatus(remote, context.sha, post.context, post.state, post.description)) {
      if (post.state === "pending") pendingPosted++;
      else notRequiredPosted++;
    }
  }
  const sha7 = context.sha.slice(0, 7);
  const parts: string[] = [];
  if (pendingPosted > 0) parts.push(`${pendingPosted} pending CTA(s)`);
  if (notRequiredPosted > 0) parts.push(`${notRequiredPosted} not-required success(es)`);
  if (parts.length === 0) {
    console.log(`Skilled PR: all ${posts.length} context(s) already attested on ${sha7}.`);
    return;
  }
  const suffix = attested > 0 ? `; left ${attested} existing attestation(s) untouched` : "";
  console.log(`Skilled PR: posted ${parts.join(" + ")} on ${sha7}${suffix}.`);
}
