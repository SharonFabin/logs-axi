import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { isPatientField, redactObject } from "../src/lib/redact.js";
import { buildQuery, parseRow as cwRow } from "../src/sources/cloudwatch.js";
import { signoz } from "../src/sources/signoz.js";
import { matchesRecord } from "../src/core/normalize.js";
import { evaluate, insightsFields, signozQueryFields } from "./query-contract.js";
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

/** Point the credentials file at an empty temp dir on every OS (XDG on POSIX, APPDATA on Windows). */
function isolateCredentials(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-axi-creds-"));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  vi.stubEnv("APPDATA", dir);
  vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", "");
  return dir;
}

describe("credential diagnostics", () => {
  it.each(["credentials file", "environment"])("rejects invalid %s keys before invoking fetch", async (origin) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      new Headers(init?.headers);
      return new Response('{"status":"success","data":{"data":{"results":[]}}}');
    });
    const dir = isolateCredentials();
    try {
      const invalidKeys = ["KEYSECRET\nSECONDSECRET", "KEYSECRET\rSECONDSECRET", "KEYSECRET\tSECONDSECRET", "KEYSECRET\u0100SECONDSECRET", ...(origin === "credentials file" ? ["KEYSECRET\0SECONDSECRET"] : [])];
      for (const key of invalidKeys) {
        vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", origin === "environment" ? key : "");
        // a hand-edited file can hold what `login` would refuse
        fs.mkdirSync(path.join(dir, "logs-axi"), { recursive: true });
        fs.writeFileSync(path.join(dir, "logs-axi", "credentials"), JSON.stringify({ signoz: { default: origin === "credentials file" ? key : "unused" } }));
        const config = { sources: { signoz: { dev: { endpoint: "http://localhost:1" } } } };
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
      fs.rmSync(dir, { recursive: true });
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
    vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", secret);
    try {
      const result = await run(["signoz", "dev", "tail"], { config: { sources: { signoz: { dev: { endpoint: "http://localhost:1" } } } }, now: NOW });
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
function wireTransport(rows: WireRow[]) {
  return async (path: string, request: any) => {
    expect(path).toBe("/api/v5/query_range");
    const results = request.compositeQuery.queries.map(({ spec }: any) => {
      const selected = rows.filter((row) => !spec.filter?.expression || evaluate(spec.filter.expression, signozQueryFields(row.data)));
      expect(request.requestType).toBe("raw");
      return { queryName: spec.name, rows: selected.slice(0, spec.limit) };
    });
    return { status: "success", data: { data: { results } } };
  };
}
const row = (data: Record<string, unknown>): WireRow => ({ timestamp: new Date(NOW - 1000).toISOString(), data });

it("SigNoz display and counts use native severity even with conflicting attributes", async () => {
  const input = row({ body: "ordinary request", severity_text: "ERROR", resources_string: { "service.name": "case-service" }, attributes_string: { severity_text: "WARN" } });
  const source = signoz({ endpoint: "http://x" }, "t", wireTransport([input]));
  expect(await source.query({ ...range, minLevel: "error", limit: 1 })).toMatchObject({ rows: [{ msg: "ordinary request", level: "error", service: "case-service" }], partial: false });
  expect(await source.serviceCounts(range)).toEqual({ rows: [{ service: "case-service", level: "error", count: 1 }], partial: false });
});

it.each(["requestId", "correlationId", "caseId", "runId", "traceId", "trace_id"])("SigNoz error sample %s follows its string attribute", async (field) => {
  const id = "request-1";
  const input = row({ body: "failed", severity_text: "ERROR", attributes_string: { [field]: id } });
  const unrelated = row({ body: "unrelated", severity_text: "INFO", attributes_string: { residentId: id } });
  const deps = { config: TEST_CONFIG, now: NOW, transports: { signoz: wireTransport([input, unrelated]) } };
  const result = await run(["signoz", "dev", "errors", "--json"], deps);
  expect(result.code).toBe(0);
  const errors = JSON.parse(result.out);
  const group = errors.groups.find((group: { template: string }) => group.template === "failed");
  expect(group.sample).toBe(id);
  expect(errors.help).toContain(`Run \`logs-axi signoz dev trace ${id}\` to see one occurrence in context`);
  const traced = await run(["signoz", "dev", "trace", group.sample, "--json"], deps);
  expect(traced.code).toBe(0);
  expect(JSON.parse(traced.out).lines).toMatchObject([{ msg: "failed" }]);
});

it("SigNoz error samples prefer the native trace ID and can follow it", async () => {
  const id = "4bf92f3577b34da6a3ce929d0e0e4736";
  const input = row({ body: "failed", severity_text: "ERROR", trace_id: id, attributes_string: { traceId: "attribute-trace", requestId: "request-1" } });
  const deps = { config: TEST_CONFIG, now: NOW, transports: { signoz: wireTransport([input]) } };
  const result = await run(["signoz", "dev", "errors", "--json"], deps);
  expect(result.code).toBe(0);
  const errors = JSON.parse(result.out);
  expect(errors.groups[0].sample).toBe(id);
  const traced = await run(["signoz", "dev", "trace", errors.groups[0].sample, "--json"], deps);
  expect(traced.code).toBe(0);
  expect(JSON.parse(traced.out).lines).toMatchObject([{ msg: "failed" }]);
});

it.each([
  [{ "service.name": "case-service" }, "case", "case-service"],
  [{ "service.name": "" }, "-", "-"],
  [{}, "-", "-"],
] as const)("SigNoz selects, renders, and counts service from resource %j", async (resource, service, expected) => {
  const input = row({ body: "failed", severity_text: "ERROR", resources_string: resource, attributes_string: { service: "other" } });
  const source = signoz({ endpoint: "http://x" }, "t", wireTransport([input]));
  expect((await source.query({ ...range, service, limit: 1 })).rows).toMatchObject([{ msg: "failed", service: expected }]);
  expect((await source.query({ ...range, service: "other", limit: 1 })).rows).toEqual([]);
  expect(await source.serviceCounts(range)).toEqual({ rows: [{ service: expected, level: "error", count: 1 }], partial: false });
});

it.each([
  [{ service: "case-service" }, "other/container/task", "case-service"],
  [{ service: "" }, "case/container/task", "case"],
  [{}, "case/container/task", "case"],
  [{ service: "" }, "", "-"],
] as const)("CloudWatch service precedence agrees for rendering, selection and count queries: %j", (body, stream, expected) => {
  const message = JSON.stringify({ level: "error", msg: "failed", ...body });
  const fields = { ...body, "@timestamp": NOW - 1000, level: "error", "@message": message, "@logStream": stream };
  expect(cwRow([{ field: "@message", value: message }, { field: "@logStream", value: stream }]).service).toBe(expected);
  expect(insightsFields(buildQuery({ ...range, service: expected === "-" ? "-" : "case", limit: 10 }), fields)).toBeDefined();
  expect(matchesRecord(cwRow([{ field: "@message", value: message }, { field: "@logStream", value: stream }]), { service: "other" })).toBe(false);
});
