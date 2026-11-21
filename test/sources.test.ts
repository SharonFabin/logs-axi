import { describe, expect, it, vi } from "vitest";
import { buildQuery, cloudwatch, parseRow as cwRow } from "../src/sources/cloudwatch.js";
import { buildFilter, parseRow as szRow, signoz } from "../src/sources/signoz.js";
import { template } from "../src/lib/template.js";
import { evaluate, insightsFields } from "./query-contract.js";
import { events, signozRaw } from "./fixtures.js";

const range = { start: 1_000_000, end: 2_000_000 };

it("preserves unknown severity labels that name inherited properties", () => {
  expect(cwRow([{ field: "@message", value: '{"level":"CONSTRUCTOR"}' }]).level).toBe("constructor");
  expect(szRow({ data: { severity_text: "CONSTRUCTOR" } }).level).toBe("constructor");
});

describe("cloudwatch", () => {
  it("builds an Insights query from the shared filters", () => {
    const q = buildQuery({ ...range, service: "case", minLevel: "error", text: "pay.er", id: "abc-123", limit: 50 });
    expect(insightsFields(q, { "@timestamp": range.start, service: "case", level: "error", "@message": "pay.er abc-123", "@logStream": "other/container/task" })).toBeDefined();
    expect(insightsFields(q, { "@timestamp": range.start, service: "case", level: "critical", "@message": "pay.er abc-123" })).toBeDefined();
    expect(insightsFields(q, { "@timestamp": range.start, service: "case", level: "info", "@message": "pay.er abc-123" })).toBeUndefined();
    expect(q).toContain("@message like /(?i)pay\\.er/");
    expect(q).toContain('@message like "abc-123"');
    expect(q).toMatch(/sort @timestamp desc\n\| limit 50$/);
  });

  it("parses JSON and plain-text rows", () => {
    const json = cwRow([
      { field: "@timestamp", value: "2026-11-16 14:00:01.250" },
      { field: "@message", value: '{"caseId":"c1","time":"2026-11-16T14:00:01.249Z","level":"error","service":"case-service","msg":"boom"}' },
      { field: "@logStream", value: "case/case/abc" },
    ]);
    expect(json).toEqual({ time: "2026-11-16T14:00:01.249Z", level: "error", service: "case-service", msg: "boom", fields: { caseId: "c1" } });
    const plain = cwRow([
      { field: "@timestamp", value: "2026-11-16 14:00:01.250" },
      { field: "@message", value: "Error: connect ECONNREFUSED" },
      { field: "@logStream", value: "case/case/abc" },
    ]);
    expect(plain).toMatchObject({ time: "2026-11-16T14:00:01.250Z", level: "error", service: "case", msg: "Error: connect ECONNREFUSED" });
  });

  it("sends StartQuery for the configured groups and polls until complete", async () => {
    const seen: string[] = [];
    let polls = 0;
    const src = cloudwatch({ region: "us-east-1", logGroups: ["/my-app/dev"] }, "t", async (cmd: any) => {
      seen.push(cmd.constructor.name);
      if (cmd.constructor.name === "StartQueryCommand") {
        expect(cmd.input).toMatchObject({ logGroupNames: ["/my-app/dev"], startTime: 1000, endTime: 2000, limit: 5 });
        return { queryId: "q" };
      }
      return ++polls < 2 ? { status: "Running" } : { status: "Complete", results: [] };
    });
    expect(await src.query({ ...range, limit: 5 })).toEqual({ rows: [], partial: false });
    expect(seen).toEqual(["StartQueryCommand", "GetQueryResultsCommand", "GetQueryResultsCommand"]);
  });

  it("reports a failed query", async () => {
    const src = cloudwatch({ region: "us-east-1", logGroups: ["g"] }, "t", async (cmd: any) =>
      cmd.constructor.name === "StartQueryCommand" ? { queryId: "q" } : { status: "Failed" },
    );
    await expect(src.query({ ...range, limit: 5 })).rejects.toThrow("cloudwatch: query failed");
  });

  it("rejects ids that could inject into the query", async () => {
    const src = cloudwatch({ region: "us-east-1", logGroups: ["g"] }, "t", async () => ({}));
    await expect(src.query({ ...range, id: 'x" or 1=1', limit: 5 })).rejects.toThrow("invalid id");
  });

  it("validates its config", () => {
    expect(() => cloudwatch({ region: "us-east-1" }, "dev")).toThrow(/logGroups/);
  });
});

describe("signoz", () => {
  it("sends literal body text to SigNoz for case-insensitive search", () => {
    const filter = buildFilter({ ...range, text: "Body.Level", limit: 1 });
    expect(evaluate(filter, { log: { body: "the body.level value is missing" } })).toBe(true);
    expect(evaluate(filter, { log: { body: "the bodyXlevel value is missing" } })).toBe(false);
  });

  it("labels a SigNoz 500 with its error type and ClickHouse code, never its message", async () => {
    vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", "test-key");
    const payload = { status: "error", error: { type: "internal", code: "unknown", message: "code: 48, message: synthetic-provider-text" } };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(payload), { status: 500 }));
    try {
      const src = signoz({ endpoint: "http://x" }, "t");
      await expect(src.query({ ...range, limit: 1 })).rejects.toThrow(/^signoz: HTTP 500: query failed \(internal, ClickHouse code 48\)$/);
    } finally {
      fetch.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("parses a raw row: body, severity, resource service, attributes, trace id", () => {
    const [ev] = events(1);
    const row = signozRaw([{ ...ev!, level: "error", msg: "boom", fields: { caseId: "c1", n: 2 } }]).data.data.results[0]!.rows[0]!;
    const r = szRow(row);
    expect(r).toMatchObject({ level: "error", service: ev!.service, msg: "boom", traceId: ev!.traceId, fields: { caseId: "c1", n: 2 } });
    expect(Object.keys(r.fields)).not.toContain("telemetry.sdk.name");
  });

  it("renders a JSON-looking message verbatim using native metadata", () => {
    const body = '{"level":"warn","service":"other","msg":"m","requestId":"body-id"}';
    const result = szRow({ timestamp: "2026-11-16T14:00:00Z", data: { body, resources_string: { "service.name": "case" } } });
    expect(result).toEqual({ time: "2026-11-16T14:00:00.000Z", level: "-", service: "case", msg: body, fields: {} });
  });

  it.each([
    [0, "-"], [1, "debug"], [4, "debug"], [5, "debug"], [8, "debug"],
    [9, "info"], [12, "info"], [13, "warn"], [16, "warn"], [17, "error"],
    [20, "error"], [21, "fatal"], [24, "fatal"], [25, "-"], [17.5, "-"],
  ])("normalizes OpenTelemetry severity %s to %s", (severity_number, level) => {
    expect(szRow({ data: { body: "connection refused", severity_number } }).level).toBe(level);
  });

  it("uses severity text when the native number is missing or invalid", () => {
    expect(szRow({ data: { body: "fatal: failed", severity_number: 9 } }).level).toBe("info");
    expect(szRow({ data: { body: "fatal: failed", severity_number: 0 } }).level).toBe("-");
    expect(szRow({ data: { body: "failed", severity_number: 17, severity_text: "info" } }).level).toBe("error");
    expect(szRow({ data: { body: "failed", severity_number: 25, severity_text: "warning" } }).level).toBe("warn");
    expect(szRow({ data: { body: "failed", severity_number: 17, severity_text: "vendor error" } }).level).toBe("error");
    expect(szRow({ data: { body: "failed", severity_number: 17, attributes_string: { level: "warn" } } }).level).toBe("error");
    expect(szRow({ data: { body: { level: "warn" }, severity_number: 17 } })).toMatchObject({ level: "error", msg: "" });
  });

  it("preserves an unrecognized severity label when no valid number is present", () => {
    expect(szRow({ data: { body: "request", severity_text: "ERROR2" } }).level).toBe("error2");
    expect(szRow({ data: { body: "request", severity_text: "ERROR2", severity_number: 18 } }).level).toBe("error");
  });

  it("surfaces an API error", async () => {
    const src = signoz({ endpoint: "http://x" }, "t", async () => ({ status: "error", error: { message: "bad filter" } }));
    await expect(src.query({ ...range, limit: 1 })).rejects.toThrow("signoz: error: query failed");
  });

  it("does not echo a failed payload's rows", async () => {
    const src = signoz({ endpoint: "http://x" }, "t", async () => ({ status: "error", data: { rows: [{ body: "Jane Testperson" }] } }));
    await expect(src.query({ ...range, limit: 1 })).rejects.toThrow(/^signoz: error: query failed$/);
  });


});

describe("template", () => {
  it.each([
    ["upstream 502 after 431ms", "upstream <n> after <n>ms"],
    ["case 3f2a1c9e-1111-4222-8333-444455556666 failed at 2026-11-16T14:00:00.123Z", "case <uuid> failed at <time>"],
    ["inv_1abc2def failed calling http://ehr.local:4004/x?y=1 from 10.0.1.12:443", "<id> failed calling <url> from <ip>"],
    ["trace 4bf92f3577b34da6a3ce929d0e0e4736 done", "trace <hex> done"],
    ["Resident [name] not found", "Resident [name] not found"],
  ])("%s", (input, expected) => expect(template(input)).toBe(expected));
});
