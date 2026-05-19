// Strict, spec-driven CLI argument parser.
//
// Before this rewrite, parseAttestArgs/parseInitArgs used `args.indexOf()`
// lookups for known flags and silently ignored anything else. That hid a
// real DX bug: invoking an older version of skilled-pr with a newer flag
// (e.g. `skilled-pr init --for codex` against v0.2.0) silently fell back
// to default behaviour instead of telling the user the flag wasn't
// supported. Users walked away thinking the harness-specific init had
// worked when it hadn't.
//
// The new parser walks argv once, left to right, and errors on:
//   - unknown --flag names
//   - unexpected positional arguments (anything not starting with --)
//   - flags missing their values
//   - duplicate flag specifications
//   - missing required flags (post-parse check)
//
// Supported flag forms:
//   --flag value        (space-separated, the existing form)
//   --flag=value        (equals-joined, new)
//
// `--flag=` with empty value is rejected; if the user genuinely needs an
// empty string they can pass `--flag ""` (two tokens).

export type FlagKind = "required" | "optional";
export type FlagSpec = Record<string, FlagKind>;

export type ParsedFlags =
  | { ok: true; values: Record<string, string | undefined> }
  | { ok: false; error: string };

/**
 * Parse `args` against a flag spec. Pure: no I/O, no process exits.
 * Callers convert the typed result into their command-specific shape.
 */
export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const known = new Set(Object.keys(spec));
  const values: Record<string, string | undefined> = {};

  let i = 0;
  while (i < args.length) {
    const token = args[i];

    if (!token.startsWith("--")) {
      return { ok: false, error: `unexpected positional argument: "${token}"` };
    }

    // Strip "--" prefix; split on "=" if present (--flag=value form).
    const stripped = token.slice(2);
    const eqIdx = stripped.indexOf("=");
    let name: string;
    let inlineValue: string | null = null;
    if (eqIdx === -1) {
      name = stripped;
    } else {
      name = stripped.slice(0, eqIdx);
      inlineValue = stripped.slice(eqIdx + 1);
    }

    if (!known.has(name)) {
      return { ok: false, error: `unknown flag: --${name}` };
    }

    if (values[name] !== undefined) {
      return { ok: false, error: `--${name} was specified more than once` };
    }

    let value: string;
    if (inlineValue !== null) {
      // --flag=value form. We treat empty (--flag=) as missing-value rather
      // than as an intentional empty string; users who need a literal empty
      // string can pass two tokens (--flag "").
      if (inlineValue.length === 0) {
        return { ok: false, error: `--${name}: requires a value` };
      }
      value = inlineValue;
      i += 1;
    } else {
      // --flag VALUE form. Next token must exist and not be another flag.
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: `--${name}: requires a value` };
      }
      value = next;
      i += 2;
    }
    values[name] = value;
  }

  // Validate required flags are present.
  for (const [name, kind] of Object.entries(spec)) {
    if (kind === "required" && values[name] === undefined) {
      return { ok: false, error: `--${name}: missing flag` };
    }
  }

  return { ok: true, values };
}

// ---------------------------------------------------------------------------
// Command-specific adapters
// ---------------------------------------------------------------------------

export type ParsedAttestArgs =
  | { ok: true; skill: string; findings?: string }
  | { ok: false; error: string };

export function parseAttestArgs(args: string[]): ParsedAttestArgs {
  const result = parseFlags(args, { skill: "required", findings: "optional" });
  if (!result.ok) return { ok: false, error: result.error };
  // `skill` is guaranteed defined because spec marks it required and
  // parseFlags returns an error otherwise. The `!` is safe here.
  return { ok: true, skill: result.values.skill!, findings: result.values.findings };
}

export type ParsedInitArgs =
  | { ok: true; forHarness?: string }
  | { ok: false; error: string };

/**
 * Parse `skilled-pr init` flags. Today the only flag is `--for`, which
 * forces hook installation to a specific harness (`claude` | `codex` |
 * `both`). Default behaviour (no flag) is auto-detection in init.ts.
 *
 * Value validation (is "codex" a known harness?) happens in init.ts; this
 * parser only ensures `--for` was given a value when present.
 */
export function parseInitArgs(args: string[]): ParsedInitArgs {
  const result = parseFlags(args, { for: "optional" });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, forHarness: result.values.for };
}
