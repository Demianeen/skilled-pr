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
