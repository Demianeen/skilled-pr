export type ParsedAttestArgs =
  | { ok: true; skill: string }
  | { ok: false; error: string };

export function parseAttestArgs(args: string[]): ParsedAttestArgs {
  const i = args.indexOf("--skill");
  if (i === -1) return { ok: false, error: "missing --skill flag" };
  const value = args[i + 1];
  if (!value || value.startsWith("--")) {
    return { ok: false, error: "--skill requires a value" };
  }
  return { ok: true, skill: value };
}
