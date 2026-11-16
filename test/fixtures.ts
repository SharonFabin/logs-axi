import { createHash } from "node:crypto";
import { evaluate, insightsFields } from "./query-contract.js";
/**
 * Synthetic log events and the raw API responses each source would return for them.
 * Everything here is invented: no real log content, names or ids. The people below
 * are fake on purpose, so tests can assert none of them survives redaction.
 */

export const FAKE_PEOPLE = ["Jane Testperson", "Testperson", "Alan Fakename", "Fakename", "Maria Placeholder", "Placeholder", "Bob Example"];

export interface Event {
  time: string;
  service: string;
  level: string;
  msg: string;
  traceId?: string;
  fields: Record<string, unknown>;
}

const BASE = Date.parse("2026-11-16T14:00:00.000Z");
const SERVICES = ["case-service", "pharmacy-service", "ehr-service", "comms-service"];

/** A deterministic pseudo-random sequence, so fixtures and bench numbers are stable. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");
const uuid = (r: () => number) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-8${hex(r, 3)}-${hex(r, 12)}`;

/** `n` events over 15 minutes: mostly request lines, some errors in a few templates, some carrying fake patient data. */
export function events(n = 200, seed = 7): Event[] {
  const r = rng(seed);
  const out: Event[] = [];
  for (let i = 0; i < n; i++) {
    const service = SERVICES[Math.floor(r() * SERVICES.length)]!;
    const time = new Date(BASE + Math.floor((i / n) * 15 * 60_000)).toISOString();
    const traceId = hex(r, 32);
    const caseId = uuid(r);
    const k = r();
    if (k < 0.1) {
      out.push({ time, service, level: "error", msg: "payer lookup failed", traceId, fields: { caseId, attempts: 1 + Math.floor(r() * 5), error: `upstream 502 after ${Math.floor(r() * 900)}ms` } });
    } else if (k < 0.16) {
      out.push({
        time,
        service: "ehr-service",
        level: "error",
        msg: "resident match failed",
        traceId,
        fields: { caseId, residentId: uuid(r), residentName: "Jane Testperson", dob: "1950-01-05", error: "Resident Jane Testperson not found in roster" },
      });
    } else if (k < 0.2) {
      out.push({
        time,
        service: "pharmacy-service",
        level: "error",
        msg: "order sync failed",
        traceId,
        fields: { caseId, prescriber: { name: "Dr. Alan Fakename", npi: "1234567890" }, error: `Prescriber Fakename, Alan rejected order ${Math.floor(r() * 99999)}` },
      });
    } else if (k < 0.25) {
      out.push({ time, service, level: "warn", msg: "slow query", traceId, fields: { caseId, durationMs: Math.floor(r() * 5000), table: "cases" } });
    } else {
      out.push({
        time,
        service,
        level: "info",
        msg: "request",
        traceId,
        fields: {
          requestId: uuid(r),
          correlationId: uuid(r),
          method: r() < 0.5 ? "GET" : "POST",
          path: "/cases/query",
          status: 200,
          ms: Math.floor(r() * 200),
          orgId: uuid(r),
          note: k > 0.98 ? "called Maria Placeholder at 813-555-0142" : undefined,
        },
      });
    }
  }
  return out;
}

const line = (e: Event) => JSON.stringify({ ...e.fields, time: e.time, level: e.level, service: e.service, msg: e.msg });

/** Logs Insights GetQueryResults for `fields @timestamp, @message, @logStream`, newest first. */
export function cloudwatchResults(evs: Event[]) {
  const sorted = [...evs].sort((a, b) => (a.time < b.time ? 1 : -1));
  return {
    $metadata: { httpStatusCode: 200, requestId: "00000000-0000-4000-8000-000000000000", attempts: 1, totalRetryDelay: 0 },
    results: sorted.map((e, i) => [
      { field: "@timestamp", value: e.time.replace("T", " ").replace("Z", "") },
      { field: "@message", value: line(e) },
      { field: "@logStream", value: `${e.service.replace(/-service$/, "")}/${e.service.replace(/-service$/, "")}/${hex(rng(i), 32)}` },
      { field: "@ptr", value: Buffer.from(hex(rng(i + 1), 128), "hex").toString("base64") },
    ]),
    statistics: { recordsMatched: sorted.length, recordsScanned: sorted.length * 40, bytesScanned: sorted.length * 40 * 350 },
    status: "Complete",
  };
}

const SEVERITY: Record<string, number> = { debug: 5, info: 9, warn: 13, error: 17 };

/** SigNoz v5 query_range raw response, the shape the OTel log bridge produces. */
export function signozRaw(evs: Event[]) {
  const sorted = [...evs].sort((a, b) => (a.time < b.time ? 1 : -1));
  return {
    status: "success",
    data: {
      type: "raw",
      data: {
        results: [
          {
            queryName: "A",
            nextCursor: "",
            rows: sorted.map((e, i) => {
              const strings: Record<string, string> = {};
              const numbers: Record<string, number> = {};
              for (const [k, v] of Object.entries(e.fields)) {
                if (typeof v === "number") numbers[k] = v;
                else if (v !== undefined) strings[k] = typeof v === "string" ? v : JSON.stringify(v);
              }
              return {
                timestamp: e.time,
                data: {
                  attributes_bool: {},
                  attributes_number: numbers,
                  attributes_string: strings,
                  body: e.msg,
                  id: createHash("sha256").update(JSON.stringify(e)).digest("hex").slice(0, 27),
                  resources_string: {
                    "service.name": e.service,
                    "deployment.environment": "dev",
                    "host.name": `ip-10-0-${i % 255}-12.ec2.internal`,
                    "telemetry.sdk.language": "nodejs",
                    "telemetry.sdk.name": "opentelemetry",
                    "telemetry.sdk.version": "2.0.1",
                    "process.runtime.name": "bun",
                  },
                  scope_name: "@my-app/observability",
                  scope_version: "",
                  severity_number: SEVERITY[e.level] ?? 9,
                  severity_text: e.level.toUpperCase(),
                  span_id: hex(rng(i + 5), 16),
                  trace_flags: 1,
                  trace_id: e.traceId ?? "",
                },
              };
            }),
          },
        ],
      },
      meta: { rowsScanned: sorted.length * 40, bytesScanned: sorted.length * 40 * 400, durationMs: 42 },
    },
  };
}

/**
 * Stub transports: answer each request from `evs`, applying the request's own filter
 * crudely (level, service, text, id), the way the real service would. They also record
 * what was asked and keep the raw payload they returned, for the bench.
 */
export interface Recorder {
  requests: unknown[];
  responses: unknown[];
}

function newest(evs: Event[], limit: number, offset = 0): Event[] {
  return [...evs].sort((a, b) => (a.time < b.time ? 1 : -1)).slice(offset, offset + limit);
}

export function cloudwatchStub(evs: Event[], rec: Recorder = { requests: [], responses: [] }) {
  let last: { queryString: string; limit: number } | undefined;
  return Object.assign(
    async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (cmd.constructor.name === "StartQueryCommand") {
        rec.requests.push(cmd.input);
        last = { queryString: String(cmd.input.queryString), limit: Number(cmd.input.limit) };
        return { queryId: "q-1" };
      }
      const q = last!.queryString;
      const selected = evs.filter((e) => insightsFields(q, { ...JSON.parse(line(e)), "@timestamp": e.time, "@message": line(e), "@logStream": `${e.service.replace(/-service$/, "")}/container/task` }));
      const res = cloudwatchResults(newest(selected, last!.limit));
      rec.responses.push(res);
      return res;
    },
    { rec },
  );
}

function signozFields(e: Event): Record<string, unknown> {
  return { attribute: e.fields, resource: { "service.name": e.service }, log: { body: e.msg, severity_text: e.level.toUpperCase(), trace_id: e.traceId } };
}

export function signozStub(evs: Event[], rec: Recorder = { requests: [], responses: [] }) {
  return Object.assign(
    async (_path: string, body: any) => {
      rec.requests.push(body);
      const spec = body.compositeQuery.queries[0].spec;
      const expr: string = spec.filter.expression;
      const res = signozRaw(newest(evs.filter((e) => !expr || evaluate(expr, signozFields(e))), spec.limit, spec.offset ?? 0));
      rec.responses.push(res);
      return res;
    },
    { rec },
  );
}

export const TEST_CONFIG = {
  sources: {
    cloudwatch: { dev: { profile: "test", region: "us-east-1", logGroups: ["/my-app/dev"] } },
    signoz: { dev: { endpoint: "http://localhost:3301" } },
  },
};

/** "now" for tests: just after the synthetic events. */
export const NOW = Date.parse("2026-11-16T14:15:00.000Z");
