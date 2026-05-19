export type ParsedAttestArgs =
  | { ok: true; skill: string; findings?: string }
  | { ok: false; error: string };

export function parseAttestArgs(args: string[]): ParsedAttestArgs {
  const skill = readRequired(args, "--skill");
  if (!skill.ok) return { ok: false, error: `--skill: ${skill.error}` };

  const findings = readOptional(args, "--findings");
  if (!findings.ok) return { ok: false, error: `--findings: ${findings.error}` };

  return { ok: true, skill: skill.value, findings: findings.value };
}

export type ParsedInitArgs =
  | { ok: true; forHarness?: string }
  | { ok: false; error: string };

/**
 * Parse `skilled-pr init` flags. Today the only flag is `--for`, which
 * forces hook installation to a specific harness (`claude` | `codex` |
 * `both`). Default behaviour (no flag) is auto-detection in init.ts.
 */
export function parseInitArgs(args: string[]): ParsedInitArgs {
  const forHarness = readOptional(args, "--for");
  if (!forHarness.ok) return { ok: false, error: `--for: ${forHarness.error}` };
  return { ok: true, forHarness: forHarness.value };
}

type Required_ = { ok: true; value: string } | { ok: false; error: string };
type Optional_ = { ok: true; value: string | undefined } | { ok: false; error: string };

function readRequired(args: string[], name: string): Required_ {
  const i = args.indexOf(name);
  if (i === -1) return { ok: false, error: "missing flag" };
  return valueAt(args, i);
}

function readOptional(args: string[], name: string): Optional_ {
  const i = args.indexOf(name);
  if (i === -1) return { ok: true, value: undefined };
  return valueAt(args, i);
}

function valueAt(args: string[], flagIndex: number): Required_ {
  const value = args[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    return { ok: false, error: "requires a value" };
  }
  return { ok: true, value };
}
