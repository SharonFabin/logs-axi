import { describe, expect, it } from "vitest";
import { buildQuery, cloudwatch, parseRow as cwRow } from "../src/sources/cloudwatch.js";
import { buildFilter, parseRow as szRow, signoz } from "../src/sources/signoz.js";
import { template } from "../src/lib/template.js";
import { events, signozRaw } from "./fixtures.js";

const range = { start: 1_000_000, end: 2_000_000 };

describe("cloudwatch", () => {
  it("builds an Insights query from the shared filters", () => {
    const q = buildQuery({ ...range, service: "case", minLevel: "error", text: "pay.er", id: "abc-123", limit: 50 });
    expect(q).toContain('filter (service in ["case", "case-service"] or @logStream like /^(case|case-service)\\//)');
    expect(q).toContain('level in ["error", "ERROR", "fatal", "FATAL"]');
    expect(q).toContain("not ispresent(level) and @message like /(?i)(error|exception|fatal|panic)/");
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
    const src = cloudwatch({ region: "us-east-1", logGroups: ["/point360/dev"] }, "t", async (cmd: any) => {
      seen.push(cmd.constructor.name);
      if (cmd.constructor.name === "StartQueryCommand") {
        expect(cmd.input).toMatchObject({ logGroupNames: ["/point360/dev"], startTime: 1000, endTime: 2000, limit: 5 });
        return { queryId: "q" };
      }
      return ++polls < 2 ? { status: "Running" } : { status: "Complete", results: [] };
    });
    expect(await src.query({ ...range, limit: 5 })).toEqual([]);
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
    expect(() => cloudwatch({ region: "us-east-1" }, "sources.cloudwatch.dev")).toThrow(/logGroups/);
  });
});

describe("signoz", () => {
  it("builds a v5 filter expression from the shared filters", () => {
    expect(buildFilter({ ...range, service: "case-service", minLevel: "warn", text: "50%_o'k", limit: 1 })).toBe(
      "service.name IN ('case-service', 'case') AND (severity_text ILIKE 'warn%' OR severity_text ILIKE 'error%' OR severity_text ILIKE 'fatal%') AND body CONTAINS '50\\\\%\\\\_o\\'k'",
    );
    expect(buildFilter({ ...range, id: "4BF92F3577B34DA6A3CE929D0E0E4736", limit: 1 })).toBe("trace_id = '4bf92f3577b34da6a3ce929d0e0e4736'");
    expect(buildFilter({ ...range, id: "req-1", limit: 1 })).toBe("(requestId = 'req-1' OR correlationId = 'req-1' OR caseId = 'req-1' OR runId = 'req-1')");
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
    await expect(src.query({ ...range, limit: 1 })).rejects.toThrow("bad filter");
  });

  it("does not echo a failed payload's rows", async () => {
    const src = signoz({ endpoint: "http://x" }, "t", async () => ({ status: "error", data: { rows: [{ body: "Jane Testperson" }] } }));
    await expect(src.query({ ...range, limit: 1 })).rejects.toThrow(/^signoz: "error"$/);
  });

  it("needs an API key before calling out", async () => {
    delete process.env.SIGNOZ_NOPE;
    const src = signoz({ endpoint: "http://127.0.0.1:9", apiKeyEnv: "SIGNOZ_NOPE" }, "sources.signoz.dev");
    await expect(src.query({ ...range, limit: 1 })).rejects.toThrow("no SigNoz API key for sources.signoz.dev");
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
