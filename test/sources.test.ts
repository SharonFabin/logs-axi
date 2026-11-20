import { describe, expect, it, vi } from "vitest";
import { buildQuery, cloudwatch, parseRow as cwRow } from "../src/sources/cloudwatch.js";
import { buildFilter, parseRow as szRow, signoz } from "../src/sources/signoz.js";
import { template } from "../src/lib/template.js";
import { evaluate, insightsFields } from "./query-contract.js";
import { events, signozRaw } from "./fixtures.js";

const range = { start: 1_000_000, end: 2_000_000 };

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
  const sourceForBody = (body: string) => signoz({ endpoint: "http://x" }, "t", async (_path, request: any) => {
    const { expression } = request.compositeQuery.queries[0].spec.filter;
    const rows = evaluate(expression, { log: { body } }) ? [{ data: { body } }] : [];
    return { data: { data: { results: [{ rows }] } } };
  });

  it("sends literal body text to SigNoz for case-insensitive search", () => {
    const filter = buildFilter({ ...range, text: "Body.Level", limit: 1 });
    expect(evaluate(filter, { log: { body: "the body.level value is missing" } })).toBe(true);
    expect(evaluate(filter, { log: { body: "the bodyXlevel value is missing" } })).toBe(false);
  });

  it.each([
    { query: { minLevel: "error" }, body: String.raw`{"msg":"failed:\nexception while opening socket"}`, expected: { level: "error", msg: "failed:\nexception while opening socket" } },
    { query: { minLevel: "error" }, body: String.raw`{"messa\u0067e":"tr\u0061ceback"}`, expected: { level: "error", msg: "traceback" } },
    { query: { minLevel: "fatal" }, body: String.raw`{"severity":"\u0063ritical"}`, expected: { level: "fatal" } },
    { query: { minLevel: "fatal" }, body: String.raw`{"severity_\u0074ext":"cRIT"}`, expected: { level: "fatal" } },
    { query: { service: "case-service" }, body: String.raw`{"service":"\u0063ase"}`, expected: { service: "case" } },
    { query: { service: "case" }, body: String.raw`{"ser\u0076ice":"case-service"}`, expected: { service: "case-service" } },
    { query: { id: "req-1" }, body: String.raw`{"requestId":"req\u002d1"}`, expected: { fields: { requestId: "req-1" } } },
    { query: { id: "4BF92F3577B34DA6A3CE929D0E0E4736" }, body: String.raw`{"\u0074race_id":"\u0034bf92f3577b34da6a3ce929d0e0e4736"}`, expected: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" } },
  ] as const)("finds a decoded match for $body", async ({ query, body, expected }) => {
    const result = await sourceForBody(body).query({ ...range, ...query, limit: 1 });
    expect(result).toMatchObject({ partial: false, rows: [expected] });
  });

  it.each([
    { query: { minLevel: "fatal" }, body: '{"Level":"CRIT"}' },
    { query: { minLevel: "error" }, body: String.raw`{"Message":"failed:\nexception"}` },
    { query: { service: "case-service" }, body: '{"Service":"case"}' },
    { query: { service: "case-service" }, body: '{"service":"Case"}' },
    { query: { id: "req-1" }, body: '{"RequestId":"req-1"}' },
    { query: { id: "req-1" }, body: '{"requestId":"REQ-1"}' },
    { query: { id: "4BF92F3577B34DA6A3CE929D0E0E4736" }, body: '{"TraceId":"4bf92f3577b34da6a3ce929d0e0e4736"}' },
    { query: { minLevel: "error" }, body: String.raw`{"level":"info","msg":"completed job \"sync\""}` },
    { query: { minLevel: "fatal" }, body: '{"context":{"severity":"critical"}}' },
    { query: { minLevel: "error" }, body: String.raw`{"msg":"complete","context":{"message":"failed:\nexception"}}` },
    { query: { service: "case" }, body: '{"context":{"service":"case"}}' },
    { query: { id: "req-1" }, body: '{"context":{"requestId":"req-1"}}' },
  ] as const)("rejects a nonmatching decoded body $body", async ({ query, body }) => {
    expect(await sourceForBody(body).query({ ...range, ...query, limit: 1 })).toEqual({ rows: [], partial: false });
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

  it("parses a JSON body like a CloudWatch line", () => {
    const r = szRow({ timestamp: "2026-11-16T14:00:00Z", data: { body: '{"level":"warn","service":"x","msg":"m","k":1}', resources_string: { "service.name": "x" } } });
    expect(r).toMatchObject({ level: "warn", service: "x", msg: "m", fields: { k: 1 } });
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
