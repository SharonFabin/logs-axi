/**
 * The shared command set. Every command runs against the `Source` interface only, so
 * each source gets all six for free. Output is built here as plain objects; the
 * caller renders TOON or JSON.
 */
import { redactRecord, type RedactStats } from "../lib/redact.js";
import { template } from "../lib/template.js";
import type { Help } from "../output/toon.js";
import type { Level, LogQuery, LogRecord, Source, TimeRange } from "./types.js";

export const MSG_MAX = 200;
export const VALUE_MAX = 80;
/** Lines `errors` scans before grouping. */
export const ERRORS_SCAN = 1000;
/** Lines `fields` samples. */
export const FIELDS_SAMPLE = 200;

export interface Ctx {
  source: Source;
  /** `logs-axi <source> <env>`, for help lines. */
  prefix: string;
  range: TimeRange;
  rangeLabel: string;
  redact: boolean;
  full: boolean;
  stats: RedactStats;
  partial?: boolean;
}

export interface Output {
  body: Record<string, unknown>;
  help: Help;
}

async function fetchLines(ctx: Ctx, q: Omit<LogQuery, "start" | "end">): Promise<LogRecord[]> {
  const { rows, partial } = await ctx.source.query({ ...q, ...ctx.range });
  ctx.partial = partial;
  return ctx.redact ? rows.map((r) => redactRecord(r, ctx.stats)) : rows;
}

function clip(s: string, max: number, full: boolean, state: { truncated: boolean }): string {
  if (full || s.length <= max) return s;
  state.truncated = true;
  return `${s.slice(0, max)}…[+${s.length - max}]`;
}

function ctxString(fields: Record<string, unknown>, full: boolean, state: { truncated: boolean }): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => {
      let s = typeof v === "string" ? v : JSON.stringify(v);
      s = clip(s, VALUE_MAX, full, state);
      return `${k}=${s}`;
    })
    .join("; ");
}

/** `14:03:22.123` when every time shares a date (returned separately), else full ISO. */
function timeColumn(times: string[]): { date?: string; fmt: (t: string) => string } {
  const dates = new Set(times.map((t) => t.slice(0, 10)));
  if (dates.size === 1 && times[0]) return { date: times[0].slice(0, 10), fmt: (t) => t.slice(11, 23) };
  return { fmt: (t) => t.replace(/\.\d+Z$/, "Z") };
}

function lineTable(ctx: Ctx, rows: LogRecord[], opts: { showTrace: boolean }) {
  const chrono = [...rows].reverse();
  const state = { truncated: false };
  const tc = timeColumn(chrono.map((r) => r.time));
  const lines = chrono.map((r) => ({
    time: tc.fmt(r.time),
    level: r.level,
    service: r.service,
    msg: clip(r.msg, MSG_MAX, ctx.full, state),
    ctx: ctxString(opts.showTrace && r.traceId ? { traceId: r.traceId, ...r.fields } : r.fields, ctx.full, state),
  }));
  return { date: tc.date, lines, truncated: state.truncated };
}

function finish(ctx: Ctx, body: Record<string, unknown>, help: Help): Output {
  if (ctx.partial) {
    body.partial = true;
    help.unshift("scan limit reached; results and counts may be partial (counts are lower bounds); narrow --since");
  }
  if (ctx.stats.droppedFields > 0) body.redacted = `${ctx.stats.droppedFields} patient-data fields dropped`;
  return { body, help };
}

/** Shared by tail, search and trace: the newest `limit` matching lines, shown oldest first. */
async function lines(ctx: Ctx, q: Omit<LogQuery, "start" | "end">, emptyHelp: Help, extraHelp: Help, showTrace = true): Promise<Output> {
  const rows = await fetchLines(ctx, q);
  if (rows.length === 0) {
    return finish(ctx, { range: ctx.rangeLabel, lines: 0 }, emptyHelp);
  }
  const t = lineTable(ctx, rows, { showTrace });
  const body: Record<string, unknown> = { range: ctx.rangeLabel };
  if (t.date) body.date = t.date;
  body.lines = t.lines;
  const help: Help = [];
  if (rows.length >= q.limit) {
    body.more = true;
    help.push(`showing the newest ${q.limit}; add --limit <n> or narrow --since for the rest`);
  }
  if (t.truncated) help.push("long values were cut (…[+N]); add --full to see them whole");
  help.push(...extraHelp);
  return finish(ctx, body, help);
}

export interface LineFlags {
  service?: string;
  level?: Level;
  text?: string;
  limit: number;
}

/** A runnable help line: `Run \`logs-axi <source> <env> <parts...>\``. Empty parts are skipped. */
function run(ctx: Ctx, ...parts: (string | false | undefined)[]): string {
  return "Run `" + [ctx.prefix, ...parts].filter(Boolean).join(" ") + "`";
}

function filterArgs(ctx: Ctx, f: Partial<LineFlags>): string {
  return [
    f.service ? `--service ${f.service}` : "",
    f.level ? `--level ${f.level}` : "",
    f.text ? JSON.stringify(ctx.redact ? "<search text>" : f.text) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function tail(ctx: Ctx, f: LineFlags): Promise<Output> {
  return lines(
    ctx,
    { service: f.service, minLevel: f.level, limit: f.limit },
    [run(ctx, "tail --since 1h", filterArgs(ctx, f)) + " to look further back", run(ctx, "services") + " to see which services are logging"],
    [run(ctx, "errors", f.service && `--service ${f.service}`) + " to group recent errors"],
  );
}

export function search(ctx: Ctx, f: LineFlags): Promise<Output> {
  return lines(
    ctx,
    { service: f.service, minLevel: f.level, text: f.text, limit: f.limit },
    [
      run(ctx, "search", filterArgs(ctx, f), "--since 24h") + " to widen the range",
      run(ctx, "fields") + " to see which fields exist",
    ],
    [run(ctx, "trace <traceId|requestId|caseId>") + " to follow one request across services"],
  );
}

export function trace(ctx: Ctx, id: string, f: LineFlags): Promise<Output> {
  return lines(
    ctx,
    { id, service: f.service, minLevel: f.level, limit: f.limit },
    [
      run(ctx, "trace", id, "--since 7d") + " to look further back",
      run(ctx, "search", JSON.stringify(id)) + " to match it anywhere in the message",
    ],
    [],
    false,
  );
}

const SAMPLE_KEYS = ["requestId", "correlationId", "caseId", "runId"];

function sampleId(fields: Record<string, unknown>): string | undefined {
  const ok = (v: unknown): v is string => typeof v === "string" && v !== "";
  for (const k of SAMPLE_KEYS) if (ok(fields[k])) return fields[k];
  return undefined;
}
const ERROR_DETAIL_KEYS = ["error", "err", "errorMessage", "exception.message", "errorName", "reason", "detail"];

function detailOf(r: LogRecord): string {
  for (const k of ERROR_DETAIL_KEYS) {
    const v = r.fields[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "string") return v;
    if (typeof v === "object" && typeof (v as { message?: unknown }).message === "string") return (v as { message: string }).message;
    return JSON.stringify(v);
  }
  return "";
}

/** The main token saver: error lines grouped by message template, with counts and one id to follow. */
export async function errors(ctx: Ctx, f: Omit<LineFlags, "text">): Promise<Output> {
  const level = f.level ?? "error";
  const rows = await fetchLines(ctx, { service: f.service, minLevel: level, limit: ERRORS_SCAN });
  if (rows.length === 0) {
    return finish(ctx, { range: ctx.rangeLabel, [level === "error" ? "errors" : `${level}+ lines`]: 0 }, [
      run(ctx, "errors --since 24h", filterArgs(ctx, { service: f.service, level: f.level })) + " to look further back",
      run(ctx, "tail", f.service && `--service ${f.service}`) + " to see the latest lines of any level",
    ]);
  }
  interface Group {
    count: number;
    service: string;
    first: string;
    last: string;
    template: string;
    sample: string;
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const detail = detailOf(r);
    const tpl = template(detail && !r.msg.includes(detail) ? `${r.msg}: ${detail}` : r.msg || detail || "(empty)");
    const key = `${r.service}\u0000${tpl}`;
    const g = groups.get(key);
    const sample = r.traceId ?? sampleId(r.fields) ?? "-";
    if (!g) {
      groups.set(key, { count: 1, service: r.service, first: r.time, last: r.time, template: tpl, sample });
      continue;
    }
    g.count++;
    if (r.time < g.first) g.first = r.time;
    if (r.time > g.last) {
      g.last = r.time;
      if (sample !== "-") g.sample = sample; // the most recent occurrence is the one worth following
    }
    if (g.sample === "-") g.sample = sample;
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
  const shown = sorted.slice(0, f.limit);
  const tc = timeColumn(rows.map((r) => r.time));
  // whole seconds: `14:03:22` under a shared date, else `11-16T14:03:22`
  const sec = (t: string) => (tc.date ? t.slice(11, 19) : t.slice(5, 19));
  const body: Record<string, unknown> = { range: ctx.rangeLabel };
  if (tc.date) body.date = tc.date;
  body.scanned = rows.length;
  body.groups = shown.map((g) => ({ ...g, first: sec(g.first), last: sec(g.last) }));
  const help: Help = [];
  if (rows.length >= ERRORS_SCAN) {
    help.push(`scanned the newest ${ERRORS_SCAN} lines only, so counts are lower bounds; narrow --since or add --service`);
  }
  if (sorted.length > shown.length) help.push(`${sorted.length - shown.length} smaller groups hidden; add --limit ${sorted.length} to see all`);
  const top = shown[0]!;
  if (top.sample !== "-") help.push(run(ctx, "trace", top.sample) + " to see one occurrence in context");
  help.push(run(ctx, "search --service", top.service, "--level", level, '"<words from a template>"') + " for the raw lines");
  return finish(ctx, body, help);
}

export async function services(ctx: Ctx): Promise<Output> {
  const { rows: counts, partial } = await ctx.source.serviceCounts(ctx.range);
  ctx.partial = partial;
  // `case` (a stream prefix) and `case-service` (the logger's name) are one service: one row, the longer name
  const by = new Map<string, { service: string; lines: number; errors: number; warns: number }>();
  for (const c of counts) {
    const key = c.service.replace(/-service$/, "");
    const s = by.get(key) ?? { service: c.service, lines: 0, errors: 0, warns: 0 };
    if (c.service.endsWith("-service")) s.service = c.service;
    s.lines += c.count;
    if (c.level === "error" || c.level === "fatal") s.errors += c.count;
    if (c.level === "warn") s.warns += c.count;
    by.set(key, s);
  }
  const rows = [...by.values()].sort((a, b) => b.lines - a.lines);
  if (rows.length === 0) {
    return finish(ctx, { range: ctx.rangeLabel, services: 0 }, [run(ctx, "services --since 24h") + " to look further back"]);
  }
  const noisiest = [...rows].sort((a, b) => b.errors - a.errors)[0]!;
  const help: Help = [];
  if (noisiest.errors > 0) help.push(run(ctx, "errors --service", noisiest.service) + " to group its errors");
  help.push(run(ctx, "tail --service <name>") + " for one service's latest lines");
  return finish(ctx, { range: ctx.rangeLabel, services: rows }, help);
}

export async function fields(ctx: Ctx, f: Omit<LineFlags, "text" | "limit">): Promise<Output> {
  const rows = await fetchLines(ctx, { service: f.service, minLevel: f.level, limit: FIELDS_SAMPLE });
  if (rows.length === 0) {
    return finish(ctx, { range: ctx.rangeLabel, sampled: 0 }, [run(ctx, "fields --since 24h") + " to sample further back"]);
  }
  const seen = new Map<string, { n: number; values: Set<string> }>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.fields)) {
      if (v === undefined || v === null || v === "") continue;
      const e = seen.get(k) ?? { n: 0, values: new Set<string>() };
      e.n++;
      if (e.values.size < 50) e.values.add(typeof v === "string" ? v : JSON.stringify(v));
      seen.set(k, e);
    }
  }
  const list = [...seen.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([field, e]) => ({
      field,
      seen: e.n,
      distinct: e.values.size >= 50 ? "50+" : e.values.size,
      examples: [...e.values].slice(0, 3).map((v) => (v.length > 30 ? v.slice(0, 30) + "…" : v)).join(" | "),
    }));
  return finish(
    ctx,
    { range: ctx.rangeLabel, sampled: rows.length, columns: "time,level,service,msg,traceId (always shown)", fields: list },
    [run(ctx, "search <value>") + " to find lines by value", run(ctx, "trace <id>") + " to follow an id across services"],
  );
}
