import { describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { isPatientField, redactObject } from "../src/lib/redact.js";
import { buildQuery, parseRow as cwRow } from "../src/sources/cloudwatch.js";
import { buildFilter, parseRow as szRow, signoz } from "../src/sources/signoz.js";
import { matchesRecord } from "../src/core/normalize.js";
import { evaluate, insightsFields } from "./query-contract.js";
import { events, NOW, TEST_CONFIG, cloudwatchStub, signozStub } from "./fixtures.js";

const range = { start: NOW - 3600e3, end: NOW };
const protectedPlurals = ["mrns", "rxNumbers", "medicalRecordNumbers", "chartNumbers", "ssns", "socialSecurityNumbers", "dobs", "birthDates", "npis", "mbis", "policyNumbers", "groupNumbers", "addresses", "cities", "allergies", "diagnoses", "phoneNumbers", "emailAddresses", "birthdays", "ages", "drugNames", "doses", "bedNumbers", "zipCodes", "prescribers"];

it("removes protected plural field families in native, nested and JSON forms while keeping operational IDs", () => {
  const operational = { residentIds: ["r-1"], caseIds: ["c-1"], requestIds: ["req-1"], status: "failed" };
  const fields: Record<string, unknown> = { ...operational };
  for (const field of protectedPlurals) for (const prefix of ["", "patient", "resident", "guardian", "emergencyContact"]) {
    const key = prefix ? prefix + field[0]!.toUpperCase() + field.slice(1) : field;
    expect(isPatientField(key)).toBe(true);
    fields[key] = ["PROTECTEDVALUE"];
    if (prefix) fields[`${prefix}.${field}`] = [123456];
  }
  expect(redactObject({ fields, list: [fields], encoded: JSON.stringify(fields) }, { droppedFields: 0 })).toEqual({ fields: operational, list: [operational], encoded: JSON.stringify(operational) });
});

it.each(["cloudwatch", "signoz"] as const)("%s removes plural identifiers from every default output consumer", async (source) => {
  const sensitive = Object.fromEntries(protectedPlurals.map((field) => [field, ["PROTECTEDVALUE"]]));
  const event = { ...events(1)[0]!, level: "error", msg: `failed ${JSON.stringify(sensitive)}`, fields: { ...sensitive, caseId: "case-1", details: JSON.stringify(sensitive), error: sensitive } };
  const deps = { config: TEST_CONFIG, now: NOW, transports: { [source]: source === "cloudwatch" ? cloudwatchStub([event]) : signozStub([event]) } };
  for (const command of [["tail", "--full"], ["search", "failed", "--full"], ["trace", "case-1", "--full"], ["errors"], ["fields"]]) {
    const result = await run([source, "dev", ...command, "--json"], deps);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("PROTECTEDVALUE");
    const output = JSON.parse(result.out);
    if (output.lines !== undefined) expect(output.lines).toHaveLength(1);
    if (output.groups !== undefined) expect(output.groups).toHaveLength(1);
    if (output.fields !== undefined) expect(output.fields.some((field: any) => field.field === "caseId")).toBe(true);
  }
});

describe("credential diagnostics", () => {
  it.each(["inline", "environment"])("rejects invalid %s keys before invoking fetch", async (origin) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      new Headers(init?.headers);
      return new Response('{"status":"success","data":{"data":{"results":[]}}}');
    });
    try {
      const invalidKeys = ["KEYSECRET\nSECONDSECRET", "KEYSECRET\rSECONDSECRET", "KEYSECRET\tSECONDSECRET", "KEYSECRET\u0100SECONDSECRET", ...(origin === "inline" ? ["KEYSECRET\0SECONDSECRET"] : [])];
      for (const key of invalidKeys) {
        vi.stubEnv("LOGS_AXI_TEST_CREDENTIAL", origin === "environment" ? key : "");
        const env = { endpoint: "http://localhost:1", apiKeyEnv: "LOGS_AXI_TEST_CREDENTIAL", ...(origin === "inline" ? { apiKey: key } : {}) };
        const config = { sources: { signoz: { dev: env } } };
        for (const command of ["tail", "services"]) {
          const result = await run(["signoz", "dev", command], { config, now: NOW });
          expect(result.code).toBe(1);
          expect(result.out).toContain("invalid API key");
          expect(result.out).not.toMatch(/KEYSECRET|SECONDSECRET/);
        }
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      fetch.mockRestore();
    }
  });

  it.each(["fetch", "response body"])("does not echo credentials from a rejected %s operation", async (failure) => {
    const secret = "PRINTABLESECRET";
    const error = new Error(`rejected ${secret}`, { cause: new Error(`cause ${secret}`) });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("SIGNOZ-API-KEY")).toBe(secret);
      if (failure === "fetch") throw error;
      return { text: async () => { throw error; } } as unknown as Response;
    });
    vi.stubEnv("LOGS_AXI_TEST_CREDENTIAL", "");
    try {
      const result = await run(["signoz", "dev", "tail"], { config: { sources: { signoz: { dev: { endpoint: "http://localhost:1", apiKey: secret, apiKeyEnv: "LOGS_AXI_TEST_CREDENTIAL" } } } }, now: NOW });
      expect(result.code).toBe(1);
      expect(result.out).toContain("request failed");
      expect(result.out).not.toContain(secret);
    } finally {
      vi.unstubAllEnvs();
      fetch.mockRestore();
    }
  });
});

type WireRow = { timestamp: string; data: Record<string, any> };
const wireFields = (row: WireRow) => ({ attribute: row.data.attributes_string ?? {}, resource: row.data.resources_string ?? {}, log: { body: row.data.body, severity_text: row.data.severity_text, trace_id: row.data.trace_id } });
function wireTransport(rows: WireRow[]) {
  return async (path: string, request: any) => {
    expect(path).toBe("/api/v5/query_range");
    const results = request.compositeQuery.queries.map(({ spec }: any) => {
      const selected = rows.filter((row) => !spec.filter?.expression || evaluate(spec.filter.expression, wireFields(row)));
      expect(request.requestType).toBe("raw");
      return { queryName: spec.name, rows: selected.slice(spec.offset ?? 0, (spec.offset ?? 0) + spec.limit) };
    });
    return { status: "success", data: { data: { results } } };
  };
}
const row = (data: Record<string, unknown>): WireRow => ({ timestamp: new Date(NOW - 1000).toISOString(), data });

it("SigNoz context predicates obey its documented context rules and count conflicting severities once", async () => {
  const input = row({ body: "ordinary request", severity_text: "ERROR", resources_string: { "service.name": "case-service", level: "FATAL" }, attributes_string: { severity_text: "WARN" } });
  const fields = wireFields(input);
  expect(evaluate("severity_text = 'ERROR'", fields)).toBe(true);
  expect(evaluate("severity_text = 'WARN'", fields)).toBe(true);
  expect(szRow(input).level).toBe("warn");
  expect(evaluate(buildFilter({ ...range, minLevel: "error", limit: 10 }), fields)).toBe(true);
  expect(matchesRecord(szRow(input), { minLevel: "error" })).toBe(false);
  const transport = wireTransport([input]);
  const src = signoz({ endpoint: "http://x" }, "t", transport);
  expect(await src.query({ ...range, minLevel: "error", limit: 10 })).toEqual({ rows: [], partial: false });
  expect(await src.serviceCounts(range)).toEqual({ rows: [{ service: "case-service", level: "warn", count: 1 }], partial: false });
});

it.each(["level", "severity", "severity_text"])("SigNoz ignores other contexts when choosing attribute.%s", async (field) => {
  const input = row({ body: "ordinary request", severity_text: "ERROR", resources_string: { "service.name": "case-service", [field]: "FATAL" }, attributes_string: { [field]: "WARN" } });
  expect(szRow(input).level).toBe("warn");
  expect(evaluate(buildFilter({ ...range, minLevel: "error", limit: 10 }), wireFields(input))).toBe(true);
  expect(matchesRecord(szRow(input), { minLevel: "error" })).toBe(false);
});

it.each(["requestId", "correlationId", "caseId", "runId", "traceId", "trace_id"])("SigNoz follows %s from JSON bodies and attributes even when it is 32 hex digits", async (field) => {
  for (const id of ["case-1", "4bf92f3577b34da6a3ce929d0e0e4736"]) {
    const body = row({ body: JSON.stringify({ level: "error", msg: "failed", [field]: id, service: "case-service" }) });
    const attribute = row({ body: "failed", severity_text: "ERROR", attributes_string: { [field]: id } });
    const unrelated = row({ body: "failed", severity_text: "ERROR", attributes_string: { residentId: id } });
    const src = signoz({ endpoint: "http://x" }, "t", wireTransport([body, attribute, unrelated]));
    expect((await src.query({ ...range, id, limit: 10 })).rows).toHaveLength(2);
    const deps = { config: TEST_CONFIG, now: NOW, transports: { signoz: wireTransport([body]) } };
    const errors = JSON.parse((await run(["signoz", "dev", "errors", "--json"], deps)).out);
    expect(errors.groups[0].sample).toBe(id);
    const traced = JSON.parse((await run(["signoz", "dev", "trace", errors.groups[0].sample, "--json"], deps)).out);
    expect(traced.lines).toHaveLength(1);
  }
});

it.each([
  [{ service: "case-service" }, { "service.name": "other-service" }, { service: "ignored-service" }, "case-service"],
  [{ service: "" }, { "service.name": "case-service" }, { service: "ignored-service" }, "case-service"],
  [{}, { "service.name": "" }, { service: "case-service" }, "case-service"],
  [{}, {}, { service: "case-service" }, "case-service"],
  [{}, {}, {}, "-"],
] as const)("SigNoz service precedence agrees for rendering, selection and counts: %j", async (body, resource, attribute, expected) => {
  const input = row({ body: JSON.stringify({ level: "error", msg: "failed", ...body }), severity_text: "ERROR", resources_string: resource, attributes_string: attribute });
  expect(szRow(input).service).toBe(expected);
  const src = signoz({ endpoint: "http://x" }, "t", wireTransport([input]));
  expect((await src.query({ ...range, service: expected === "-" ? "-" : "case", limit: 10 })).rows).toHaveLength(1);
  expect((await src.query({ ...range, service: "other", limit: 10 })).rows).toHaveLength(0);
  expect(await src.serviceCounts(range)).toEqual({ rows: [{ service: expected, level: "error", count: 1 }], partial: false });
});

it("SigNoz resource-only service counts tolerate absent body and attribute service values", async () => {
  const input = row({ body: "request", severity_text: "INFO", resources_string: { "service.name": "case-service" } });
  const src = signoz({ endpoint: "http://x" }, "t", wireTransport([input]));
  expect(await src.serviceCounts(range)).toEqual({ rows: [{ service: "case-service", level: "info", count: 1 }], partial: false });
});

it("SigNoz keeps body services distinct when their resource service is shared", async () => {
  const rows = ["case-service", "ehr-service"].map((service) => row({ body: JSON.stringify({ service, level: "error", msg: "failed" }), resources_string: { "service.name": "shared-service" } }));
  const src = signoz({ endpoint: "http://x" }, "t", wireTransport(rows));
  expect(await src.serviceCounts(range)).toEqual({ rows: [
    { service: "case-service", level: "error", count: 1 },
    { service: "ehr-service", level: "error", count: 1 },
  ], partial: false });
});

it.each([
  [{ service: "case-service" }, "other/container/task", "case-service"],
  [{ service: "" }, "case/container/task", "case"],
  [{}, "case/container/task", "case"],
  [{ service: "" }, "", "-"],
] as const)("CloudWatch service precedence agrees for rendering, selection and count queries: %j", (body, stream, expected) => {
  const message = JSON.stringify({ level: "error", msg: "failed", ...body });
  const fields = { ...body, level: "error", "@message": message, "@logStream": stream };
  expect(cwRow([{ field: "@message", value: message }, { field: "@logStream", value: stream }]).service).toBe(expected);
  expect(insightsFields(buildQuery({ ...range, service: expected === "-" ? "-" : "case", limit: 10 }), fields)).toBeDefined();
  expect(matchesRecord(cwRow([{ field: "@message", value: message }, { field: "@logStream", value: stream }]), { service: "other" })).toBe(false);
});
