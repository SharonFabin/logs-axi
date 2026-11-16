/** Shared helpers adapters use to normalize what their source returns. */
import { LEVELS, type Level, type LogRecord } from "./types.js";

export const LEVEL_ALIASES: Record<string, Level> = {
  trace: "debug",
  debug: "debug",
  info: "info",
  notice: "info",
  warn: "warn",
  warning: "warn",
  err: "error",
  error: "error",
  fatal: "fatal",
  critical: "fatal",
  crit: "fatal",
  panic: "fatal",
  emergency: "fatal",
};

/** Maps any spelling (`ERROR`, `Warning`, `crit`) to the five levels; unknown stays as given, lowercased. */
export function normalizeLevel(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "-";
  const l = raw.toLowerCase();
  return LEVEL_ALIASES[l] ?? l;
}

/** The levels at or above `min`, e.g. warn -> [warn, error, fatal]. */
export function levelsAtLeast(min: Level): Level[] {
  return LEVELS.slice(LEVELS.indexOf(min));
}

/** `case` and `case-service` name one service: the logger says one, the stream prefix the other. */
export function serviceAliases(name: string): string[] {
  return name.endsWith("-service") ? [name, name.slice(0, -"-service".length)] : [name, `${name}-service`];
}

const STRUCTURAL = new Set(["time", "timestamp", "@timestamp", "level", "severity", "severity_text", "service", "msg", "message"]);

/**
 * One line of the house JSON log shape `{time, level, service, msg, ...fields}`; a line
 * that is not JSON becomes the message as-is. `fallbackService` is used when the line
 * names none (CloudWatch's stream prefix, SigNoz's resource).
 */
export function parseLine(raw: string, fallback: { time: string; service: string; level?: string; traceId?: string }): LogRecord {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) if (!STRUCTURAL.has(k)) fields[k] = v;
        const traceId = str(obj.traceId) ?? str(obj.trace_id) ?? fallback.traceId;
        delete fields.traceId;
        delete fields.trace_id;
        return {
          time: isoTime(obj.time ?? obj.timestamp) ?? fallback.time,
          level: normalizeLevel(str(obj.level) ?? str(obj.severity) ?? str(obj.severity_text) ?? str(fallback.level) ?? inferLevel(str(obj.msg) ?? str(obj.message) ?? trimmed)),
          service: str(obj.service) ?? fallback.service,
          msg: str(obj.msg) ?? str(obj.message) ?? "",
          ...(traceId ? { traceId } : {}),
          fields,
        };
      }
    } catch {
      // not JSON after all: fall through to plain text
    }
  }
  return {
    time: fallback.time,
    level: normalizeLevel(str(fallback.level) ?? inferLevel(trimmed)),
    service: fallback.service,
    msg: trimmed,
    ...(fallback.traceId ? { traceId: fallback.traceId } : {}),
    fields: {},
  };
}

/** A plain-text line's level, guessed from its words. Only used when the line has no level field. */
export const INFERRED_LEVELS = [
  ["fatal", String.raw`\b(fatal|panic)\b`],
  ["error", String.raw`\b(error|exception|traceback)\b`],
  ["warn", String.raw`\bwarn(ing)?\b`],
] as const;

function inferLevel(text: string): string | undefined {
  return INFERRED_LEVELS.find(([, pattern]) => new RegExp(pattern, "i").test(text))?.[0];
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** ISO string, epoch ms/ns number or numeric string -> ISO, else undefined. */
export function isoTime(v: unknown): string | undefined {
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) {
    let n = Number(v);
    if (n > 1e17) n = n / 1e6; // ns
    else if (n > 1e14) n = n / 1e3; // us
    else if (n < 1e11) n = n * 1e3; // s
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === "string" && v) {
    const d = new Date(v.includes("T") || v.endsWith("Z") ? v : v.replace(" ", "T") + "Z");
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/** Ids and service names go into query languages; only this alphabet is accepted. */
export const SAFE_TOKEN = /^[A-Za-z0-9_.:\-]+$/;
