import { loadConfig } from "./config";
import { parseGitHubRemote, buildStatusContext, type GitHubRemote } from "./github";
import { parseAttestArgs } from "./args";

export async function attest(args: string[]) {
  const parsed = parseAttestArgs(args);
  if (!parsed.ok) {
    console.error(`Usage: skilled-pr attest --skill <name>\n  (${parsed.error})`);
    process.exit(1);
  }
  const skillName = parsed.skill;

  const config = await loadConfig();
  if (!config) {
    console.warn("Skilled PR: no .skilledpr.jsonc found. Run 'skilled-pr init' to set up.");
    process.exit(0);
  }

  const sha = getCommitSha();
  if (!sha) {
    console.error("Skilled PR: not in a git repo or no commits yet.");
    process.exit(1);
  }

  const remote = getRemote();
  if (!remote) {
    console.error("Skilled PR: no GitHub remote configured. Push to GitHub first.");
    process.exit(1);
  }

  if (config.sha === "pushed" && !isCommitPushed(sha)) {
    console.warn(`Skilled PR: HEAD (${sha.slice(0, 7)}) is not pushed to remote. Skipping attestation.`);
    process.exit(0);
  }

  const context = buildStatusContext(config.statusName, skillName);

  if (hasExistingStatus(remote, sha, context)) {
    console.log(`Skilled PR: "${context}" already attested for ${sha.slice(0, 7)}. Skipping.`);
    process.exit(0);
  }

  postStatus(remote, sha, context, skillName);
  console.log(`Skilled PR ✓ — attested "${skillName}" on ${sha.slice(0, 7)}`);
}

function getCommitSha(): string | null {
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString().trim();
}

function getRemote(): GitHubRemote | null {
  const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"]);
  if (proc.exitCode !== 0) return null;
  return parseGitHubRemote(proc.stdout.toString());
}

function isCommitPushed(sha: string): boolean {
  const proc = Bun.spawnSync(["git", "branch", "-r", "--contains", sha]);
  return proc.exitCode === 0 && proc.stdout.toString().trim().length > 0;
}

function hasExistingStatus(remote: GitHubRemote, sha: string, context: string): boolean {
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/commits/${sha}/statuses`,
    "--jq", `.[] | select(.context == $ctx) | .state`,
    "--arg", "ctx", context,
  ]);
  return proc.exitCode === 0 && proc.stdout.toString().trim().length > 0;
}

function postStatus(remote: GitHubRemote, sha: string, context: string, skillName: string) {
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/statuses/${sha}`,
    "-X", "POST",
    "-f", "state=success",
    "-f", `context=${context}`,
    "-f", `description=Reviewed by ${skillName}`,
  ]);

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString();
    if (stderr.includes("auth") || stderr.includes("login")) {
      console.error("Skilled PR: gh is not authenticated. Run 'gh auth login' first.");
    } else {
      console.error(`Skilled PR: failed to post status.\n${stderr}`);
    }
    process.exit(1);
  }
}
