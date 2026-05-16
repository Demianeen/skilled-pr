export interface GitHubRemote {
  owner: string;
  repo: string;
}

export function parseGitHubRemote(url: string): GitHubRemote | null {
  const trimmed = url.trim();
  const match = trimmed.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export function buildStatusContext(statusName: string, skillName: string): string {
  return `${statusName} / ${skillName}`;
}

// ---------------------------------------------------------------------------
// gh CLI error classification
//
// `gh api` failures emit human-readable stderr like:
//   gh: Not Found (HTTP 404)
//   gh: Unauthorized (HTTP 401)
//   gh: API rate limit exceeded (HTTP 403)
//
// The boundary cases that matter most for skilled-pr:
//   * 404 on a write operation usually means "you can READ this repo but
//     can't WRITE here." GitHub returns 404 (not 403) for write attempts to
//     repos you can read but not write to — this is deliberate, to avoid
//     leaking the existence of private repos to enumeration. Practical
//     consequence: a user whose `gh` is logged into a read-only account
//     gets the same "Not Found" message as someone who typed the wrong
//     repo name. We have to disambiguate based on the operation context.
//   * 401 always means "your token is bad" — clear retry path.
//   * 403 + "rate limit" is a separate category — retry-after applies.
//
// `classifyGhError` is a pure function so the message-building logic is
// unit-testable without spawning `gh`.
// ---------------------------------------------------------------------------

export type GhOperation =
  | "post-status"
  | "post-comment"
  | "edit-comment"
  | "fetch-status"
  | "fetch-pulls"
  | "fetch-comments";

export interface GhErrorContext {
  /** Which kind of API call failed. Drives wording of the 404 hint. */
  operation: GhOperation;
  /** Optional owner/repo, used to make the 404 hint concrete. */
  remote?: GitHubRemote;
}

export interface GhErrorClassification {
  /** HTTP status code parsed from stderr's `(HTTP NNN)` tail, else null. */
  httpStatus: number | null;
  /** stderr suggests an auth problem (401 or gh's own "not authenticated"). */
  isAuth: boolean;
  /** stderr suggests "Not Found" (404 or literal phrase). */
  isNotFound: boolean;
  /** stderr matches a rate-limit pattern. */
  isRateLimit: boolean;
  /** Formatted user-facing message with actionable hints. */
  message: string;
  /** Original stderr for fallback / debugging. */
  raw: string;
}

/**
 * Parse `gh` CLI stderr into a structured classification + human-facing
 * message. The message includes actionable next steps (commands to run).
 */
export function classifyGhError(stderr: string, context: GhErrorContext): GhErrorClassification {
  const raw = stderr;
  const httpMatch = stderr.match(/\(HTTP (\d{3})\)/);
  const httpStatus = httpMatch ? Number.parseInt(httpMatch[1], 10) : null;

  // Detect rate limit FIRST (it's a 403 subset, so order matters).
  const isRateLimit = /API rate limit|rate limit exceeded/i.test(stderr);

  // Auth: gh's own "not authenticated" output OR HTTP 401.
  const isAuth =
    !isRateLimit &&
    (httpStatus === 401 ||
      /not authenticated|gh auth login|authentication required|bad credentials/i.test(stderr));

  // Not Found: HTTP 404 OR literal "Not Found" in stderr (without rate limit).
  const isNotFound = !isRateLimit && (httpStatus === 404 || /Not Found/i.test(stderr));

  const repoLabel = context.remote ? `${context.remote.owner}/${context.remote.repo}` : "this repo";
  const isWrite =
    context.operation === "post-status" ||
    context.operation === "post-comment" ||
    context.operation === "edit-comment";

  let message: string;

  if (isRateLimit) {
    message = [
      `Skilled PR: GitHub rate limit hit on ${context.operation}.`,
      `Wait a few minutes, or use a token with higher limits.`,
    ].join("\n");
  } else if (isAuth) {
    message = [
      `Skilled PR: gh is not authenticated for ${context.operation}.`,
      ``,
      `Run: gh auth status        (to see active accounts)`,
      `Run: gh auth login         (to sign in)`,
      `Run: gh auth refresh       (if your token expired)`,
    ].join("\n");
  } else if (isNotFound && isWrite) {
    // The interesting case: 404 on a write usually means write-permission
    // missing rather than "repo doesn't exist." See header comment.
    message = [
      `Skilled PR: GitHub returned 404 on ${context.operation}.`,
      ``,
      `This usually means your active gh account lacks write access on ${repoLabel}.`,
      `(GitHub returns 404 instead of 403 to avoid leaking repo existence.)`,
      ``,
      `Check which account is active and what scopes it has:`,
      `  gh auth status`,
      ``,
      `If you have multiple accounts, switch to one with write access:`,
      `  gh auth switch`,
      ``,
      `Or refresh the current token to add 'repo' scope:`,
      `  gh auth refresh -s repo`,
    ].join("\n");
  } else if (isNotFound) {
    // 404 on a read — the repo, PR, or commit may genuinely not exist.
    message = [
      `Skilled PR: GitHub returned 404 on ${context.operation}.`,
      ``,
      `The repo, commit, or resource may not exist on ${repoLabel},`,
      `or your active gh account lacks read access.`,
      ``,
      `Verify:`,
      `  git remote get-url origin   (is the remote pointing where you think?)`,
      `  gh auth status              (which account is active?)`,
    ].join("\n");
  } else if (httpStatus !== null) {
    // Some other HTTP error — show the code + raw stderr.
    message = [`Skilled PR: GitHub returned HTTP ${httpStatus} on ${context.operation}.`, ``, stderr.trim()].join("\n");
  } else {
    // No HTTP code parsed — network error, gh binary missing, etc.
    message = [`Skilled PR: gh command failed during ${context.operation}.`, ``, stderr.trim()].join("\n");
  }

  return { httpStatus, isAuth, isNotFound, isRateLimit, message, raw };
}
