import { usageError } from "./errors.js";
import type { TimeRange } from "../core/types.js";

const UNIT_MS: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };

/** `30s`, `15m`, `1h`, `2d`, `1w` -> milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)([smhdw])$/.exec(s.trim());
  if (!m) throw usageError(`invalid duration \`${s}\``, ["use a number and a unit: 30s, 15m, 1h, 2d, 1w"]);
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

function parseInstant(s: string, flag: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw usageError(`invalid --${flag} \`${s}\``, ["use ISO-8601, e.g. 2026-11-16T14:00:00Z"]);
  return t;
}

/** --from/--until win over --since; --since counts back from --until (or now). */
export function resolveRange(flags: Record<string, string | boolean>, defaultSince: string, now: number): TimeRange {
  const end = typeof flags.until === "string" ? parseInstant(flags.until, "until") : now;
  const start =
    typeof flags.from === "string"
      ? parseInstant(flags.from, "from")
      : end - parseDuration(typeof flags.since === "string" ? flags.since : defaultSince);
  if (start >= end) throw usageError("the time range is empty: --from must be before --until");
  return { start, end };
}

/** A short human label for a range: `last 15m` or `14:00:00Z..15:00:00Z`. */
export function rangeLabel(r: TimeRange, flags: Record<string, string | boolean>, defaultSince: string): string {
  if (typeof flags.from !== "string" && typeof flags.until !== "string") {
    return `last ${typeof flags.since === "string" ? flags.since : defaultSince}`;
  }
  return `${new Date(r.start).toISOString()}..${new Date(r.end).toISOString()}`;
}
