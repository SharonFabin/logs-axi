/**
 * SigNoz through its v5 query API (POST /api/v5/query_range: read-only).
 *
 * Env config: { "endpoint": "http://localhost:3301" }
 * The key comes from $LOGS_AXI_SIGNOZ_KEY, else the credentials file
 * `logs-axi signoz login` writes (src/lib/credentials.ts). It is sent as the
 * SIGNOZ-API-KEY header and never printed.
 */
import { AxiError } from "../lib/errors.js";
import { signozKey, validKey } from "../lib/credentials.js";
import { ID_FIELDS, INFERRED_LEVELS, LEVEL_ALIASES, MAX_SCAN, countServices, isoTime, levelsAtLeast, matchesRecord, parseLine, SAFE_TOKEN, serviceAliases, str } from "../core/normalize.js";
import type { LogQuery, LogRecord, QueryResult, ServiceCount, Source, SourceFactory, TimeRange } from "../core/types.js";

export interface SignozEnv {
  endpoint: string;
}

export type SignozTransport = (path: string, body: unknown) => Promise<unknown>;

export const signoz: SourceFactory = (raw, envName, transport) => {
  const label = `sources.signoz.${envName}`;
  const env = validate(raw, label);
  return new SignozSource((transport as SignozTransport | undefined) ?? httpTransport(env, label, envName));
};

function validate(raw: Record<string, unknown>, label: string): SignozEnv {
  if (typeof raw.endpoint !== "string" || !/^https?:\/\//.test(raw.endpoint)) {
    throw new AxiError(`config ${label} needs "endpoint" (http[s]://host:port)`, {
      help: ['e.g. { "endpoint": "http://localhost:3301" }'],
    });
  }
  return raw as unknown as SignozEnv;
}

function providerError(status: number | "error", payload?: unknown, key?: string): AxiError {
  const details = payload as { code?: unknown; type?: unknown; error?: { code?: unknown; type?: unknown } } | undefined;
  const auth = status === 401 || status === 403;
  // only fixed-shape tokens, never provider text: a message can quote log rows or the key
  const safe = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) && value !== "unknown" && !value.includes(key!);
  const code = !auth && key ? [details?.error?.code, details?.error?.type, details?.code, details?.type].find(safe) : undefined;
  const message = (details as { error?: { message?: unknown }; message?: unknown } | undefined)?.error?.message ?? (details as { message?: unknown } | undefined)?.message;
  const clickhouse = !auth && key && typeof message === "string" ? /^code: (\d{1,4}),/.exec(message)?.[1] : undefined;
  const reason = [code, clickhouse && !clickhouse.includes(key!) ? `ClickHouse code ${clickhouse}` : undefined].filter(Boolean).join(", ");
  return new AxiError(`signoz: ${status === "error" ? status : `HTTP ${status}`}: query failed${reason ? ` (${reason})` : ""}`, {
    help: [auth ? "Check your viewer key with `logs-axi signoz login`" : "Check the SigNoz endpoint configuration and query filters"],
  });
}

function httpTransport(env: SignozEnv, label: string, envName: string): SignozTransport {
  return async (path, body) => {
    const key = signozKey(envName);
    if (!key) throw new AxiError(`no SigNoz API key for ${label}`, { help: ["Run `logs-axi signoz login`"] });
    if (!validKey(key)) throw new AxiError("signoz: invalid API key; use a single printable ASCII token", { help: ["Run `logs-axi signoz login` to replace it"] });
    let res: Response;
    let text: string;
    try {
      res = await fetch(env.endpoint.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "content-type": "application/json", "SIGNOZ-API-KEY": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      text = await res.text();
    } catch {
      throw new AxiError("signoz: request failed; check the endpoint and connection", {
        help: ["is the SigNoz endpoint reachable (is the port-forward up)?"],
      });
    }
    if (!res.ok) {
      let error: unknown;
      try { error = JSON.parse(text); } catch {}
      throw providerError(res.status, error, key);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AxiError("signoz: response is not valid JSON");
    }
    if (payload?.status && payload.status !== "success") {
      throw providerError("error", payload, key);
    }
    return payload;
  };
}

/** Quote a literal for the v5 filter grammar; LIKE wildcards made literal when `like`. */
const lit = (s: string, like = false) =>
  "'" + (like ? s.replace(/[\\%_]/g, "\\$&") : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

const LEVEL_FIELDS = ["attribute.level", "attribute.severity", "attribute.severity_text", "log.severity_text"];
const SERVICE_FILTER_FIELDS = ["resource.service.name", "attribute.service"];
const any = (parts: string[]) => "(" + parts.join(" OR ") + ")";
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `"key": "value"` in the raw body text, case-insensitively. Never `body.<key>`: SigNoz
 * compiles that to ClickHouse JSON_VALUE, which deployments without JSON functions reject
 * with HTTP 500. A wider match is fine, rows are re-checked by matchesRecord.
 */
const bodyPair = (keys: readonly string[], values: string[]) =>
  `log.body REGEXP ${lit(`(?i)"(${keys.join("|")})"\\s*:\\s*"(${values.map(escapeRegex).join("|")})"`)}`;

/** The v5 filter expression for a LogQuery. Exported for tests. */
export function buildFilter(q: LogQuery): string {
  const parts: string[] = [];
  if (q.service && q.service !== "-") {
    const names = serviceAliases(q.service);
    parts.push(any([...SERVICE_FILTER_FIELDS.map((field) => `${field} IN (${names.map((name) => lit(name)).join(", ")})`), bodyPair(["service"], names)]));
  }
  if (q.minLevel && q.minLevel !== "debug") {
    const levels = levelsAtLeast(q.minLevel);
    const aliases = Object.entries(LEVEL_ALIASES).filter(([, level]) => levels.includes(level)).map(([alias]) => alias);
    parts.push(any([
      ...LEVEL_FIELDS.map((field) => `${field} REGEXP ${lit("(?i)^(" + aliases.join("|") + ")$")}`),
      bodyPair(["level", "severity", "severity_text"], aliases),
      ...INFERRED_LEVELS.filter(([level]) => levels.includes(level)).map(([, pattern]) => `log.body REGEXP ${lit("(?i)" + pattern)}`),
    ]));
  }
  if (q.text) parts.push(`log.body CONTAINS ${lit(q.text, true)}`);
  if (q.id) {
    const hex = /^[0-9a-f]{32}$/i.test(q.id);
    const matches = ID_FIELDS.map((field) => hex ? `attribute.${field} REGEXP ${lit("(?i)^" + q.id + "$")}` : `attribute.${field} = ${lit(q.id!)}`);
    matches.push(bodyPair(ID_FIELDS, [q.id]));
    if (hex) matches.push(`log.trace_id = ${lit(q.id.toLowerCase())}`);
    parts.push(any(matches));
  }
  return parts.join(" AND ");
}

export function rawRequest(q: LogQuery, offset = 0): unknown {
  return {
    schemaVersion: "v1",
    start: q.start,
    end: q.end,
    requestType: "raw",
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "logs",
            filter: { expression: buildFilter(q) },
            limit: q.limit,
            offset,
            order: [
              { key: { name: "timestamp" }, direction: "desc" },
              { key: { name: "id" }, direction: "desc" },
            ],
          },
        },
      ],
    },
  };
}

interface V5Result {
  rows?: { timestamp?: unknown; data?: Record<string, unknown> }[] | null;
}

function results(payload: unknown): V5Result[] {
  const p = payload as { status?: string; error?: unknown; data?: { data?: { results?: V5Result[] | null } } };
  // never echo the payload itself: a failed response can still carry rows
  if (p?.status && p.status !== "success") throw providerError("error");
  return p?.data?.data?.results ?? [];
}

const NOISE = /^(log\.|code\.|telemetry\.|otel\.)/;

/** One v5 raw row -> a LogRecord. Exported for tests. */
export function parseRow(row: { timestamp?: unknown; data?: Record<string, unknown> }): LogRecord {
  const d = row.data ?? {};
  const resources = { ...(d.resources_string as object), ...(d.resource as object) } as Record<string, unknown>;
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (/^attributes(_|$)/.test(k) && v && typeof v === "object") Object.assign(attrs, v);
  }
  for (const k of Object.keys(attrs)) if (NOISE.test(k)) delete attrs[k];
  const traceId = typeof d.trace_id === "string" && d.trace_id && !/^0+$/.test(d.trace_id) ? d.trace_id : undefined;
  const body = typeof d.body === "string" ? d.body : JSON.stringify(d.body ?? "");
  const rec = parseLine(body, {
    time: isoTime(row.timestamp ?? d.timestamp) ?? "",
    service: str(resources["service.name"]) ?? str(attrs.service) ?? "-",
    level: [attrs.level, attrs.severity, attrs.severity_text, d.severity_text].find((v): v is string => typeof v === "string" && v !== ""),
    ...(traceId ? { traceId } : {}),
  });
  // a JSON body already carried its own fields; attributes add the rest
  delete attrs.service;
  delete attrs.level;
  delete attrs.severity;
  delete attrs.severity_text;
  return { ...rec, fields: { ...attrs, ...rec.fields } };
}

function rowIds(data: Record<string, unknown>): string[] {
  let body: unknown = data.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
  const native = str(data.trace_id);
  const fields = [body, ...Object.entries(data).filter(([key]) => /^attributes(_|$)/.test(key)).map(([, value]) => value)];
  return [native && !/^0+$/.test(native) ? native : undefined, ...fields.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return ID_FIELDS.map((field) => str(record[field]));
  })].filter((value): value is string => value !== undefined);
}

class SignozSource implements Source {
  constructor(private request: SignozTransport) {}

  async query(q: LogQuery): Promise<QueryResult<LogRecord>> {
    if (q.service && !SAFE_TOKEN.test(q.service)) throw new AxiError(`invalid service name \`${q.service}\``, { exitCode: 2 });
    if (q.id && !SAFE_TOKEN.test(q.id)) throw new AxiError(`invalid id \`${q.id}\``, { exitCode: 2 });
    const rows: LogRecord[] = [];
    const seen = new Set<string>();
    const pageSize = Math.min(1000, q.minLevel || q.service || q.id ? Math.max(100, q.limit) : q.limit);
    let offset = 0;
    while (offset < MAX_SCAN) {
      const limit = Math.min(pageSize, MAX_SCAN - offset);
      const page = results(await this.request("/api/v5/query_range", rawRequest({ ...q, limit }, offset))).flatMap((result) => result.rows ?? []);
      offset += page.length;
      for (const row of page) {
        const id = str(row.data?.id);
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        const record = parseRow(row);
        if (matchesRecord(record, q) || q.id && rowIds(row.data ?? {}).some((id) => matchesRecord({ ...record, traceId: id }, q))) rows.push(record);
        if (rows.length === q.limit) return { rows, partial: false };
      }
      if (page.length < limit) return { rows, partial: false };
    }
    return { rows, partial: true };
  }

  async serviceCounts(range: TimeRange): Promise<QueryResult<ServiceCount>> {
    const sample = await this.query({ ...range, limit: MAX_SCAN });
    return { rows: countServices(sample.rows), partial: sample.partial || sample.rows.length >= MAX_SCAN };
  }
}
