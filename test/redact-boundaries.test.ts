import { describe, expect, it, vi } from "vitest";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { run } from "../src/cli.js";
import { isPatientField, maskText, redactObject } from "../src/lib/redact.js";
import { cloudwatch } from "../src/sources/cloudwatch.js";
import { signoz } from "../src/sources/signoz.js";
import { NOW, TEST_CONFIG, cloudwatchStub, events, signozStub } from "./fixtures.js";

const labels = [
  ...["ssn:", "SSN", "social security number", "social-security-number:"].flatMap((label) => [
    [label, "123456789", "[ssn]"], [label, "123-45-6789", "[ssn]"],
  ]),
  ["MRN:", "A12345", "[mrn]"], ["MR#", "A12345", "[mrn]"], ["medical record number:", "A12345", "[mrn]"],
  ["Rx #", "123456", "[rx]"], ["Rx number:", "123456", "[rx]"],
  ...["member", "subscriber", "policy", "medicaid", "medicare", "mbi", "beneficiary", "insurance"].map((label) => [`${label} id:`, "MBR12345", "[id]"]),
  ...["room", "rm.", "bed"].map((label) => [`${label} #`, "12B", "[room]"]),
  ["DOB:", "1950-01-05", "[dob]"], ["date of birth:", "01/05/1950", "[dob]"], ["birth date:", "January 5, 1950", "[dob]"],
];

describe("labelled identifier value contract", () => {
  for (const [label, value, replacement] of labels) for (const quote of ["", "'", '"']) {
    it(`masks ${label} ${quote}${value}${quote} as a whole value`, () => {
      expect(maskText(`failed ${label} ${quote}${value}${quote}; retry`)).toBe(`failed ${replacement}; retry`);
    });
  }
});

it("runs exact, person-name and prefix rules on normalized singular fields, preserving operational IDs and service names", () => {
  const protectedKeys = ["medicationName", "providerName", "userName", "personName", "memberId", "medicaidId", "mrn", "rxNumber", "medicalRecordNumber", "npi", "dob"];
  const fields: Record<string, unknown> = { residentIds: ["r-1"], caseIds: ["c-1"], residentCounts: 2, "service.name": "case-service", "host.name": "node-1" };
  const expected = { ...fields };
  for (const key of protectedKeys) for (const suffix of ["", "s"]) for (const namespace of ["", "ctx.", "ctx/", "ctx:"]) {
    const name = `${namespace}${key}${suffix}`;
    expect(isPatientField(name)).toBe(true);
    fields[name] = ["PROTECTEDVALUE"];
  }
  for (const key of ["provider.names", "user.names", "person.names", "medication.names", "patient.memberIds", "patient:medicaidIds", "patient/mrns", "ctx:patientContext", "ctx.patientContactDetails"]) {
    expect(isPatientField(key)).toBe(true);
    fields[key] = ["PROTECTEDVALUE"];
  }
  expect(redactObject(fields, { droppedFields: 0 })).toEqual(expected);
  expect(redactObject({ native: fields, encoded: JSON.stringify(fields), array: [fields] }, { droppedFields: 0 })).toEqual({ native: expected, encoded: JSON.stringify(expected), array: [expected] });
});

it.each(["cloudwatch", "signoz"] as const)("%s sanitizes plural names and quoted identifiers before every output consumer", async (source) => {
  const event = { ...events(1)[0]!, level: "error", msg: "failed MRN: 'A12345'; invalid ssn: 123456789", fields: {
    caseId: "case-1", medicationNames: ["apixaban"], providerNames: ["PROTECTEDVALUE"], "ctx:userNames": ["PROTECTEDVALUE"],
    details: JSON.stringify({ personNames: ["PROTECTEDVALUE"], message: 'member id: "MBR12345"; social security number "123456789"' }),
    error: "Rx # '123456'; SSN 123456789", note: 'bed # "12B"; ssn: 123456789',
    counts: { "ssn: 123456789": 1 }, requestId: "987654321",
  } };
  const deps = { config: TEST_CONFIG, now: NOW, transports: { [source]: source === "cloudwatch" ? cloudwatchStub([event]) : signozStub([event]) } };
  for (const command of [["tail", "--full"], ["search", "failed", "--full"], ["trace", "case-1", "--full"], ["errors"], ["fields"]]) {
    const result = await run([source, "dev", ...command, "--json"], deps);
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/A12345|MBR12345|123456|12B|PROTECTEDVALUE|apixaban/);
    const output = JSON.parse(result.out);
    if (output.lines !== undefined || output.fields !== undefined) expect(result.out).toContain("987654321");
    if (output.lines !== undefined) expect(output.lines).toHaveLength(1);
    if (output.groups !== undefined) expect(output.groups).toHaveLength(1);
    if (output.fields !== undefined) expect(output.fields.some((field: any) => field.field === "caseId")).toBe(true);
  }
});

it("masks quoted identifiers in AWS SDK diagnostics", async () => {
  const send = vi.spyOn(CloudWatchLogsClient.prototype, "send").mockRejectedValue(new Error("MRN: 'A12345'; ssn: 123456789"));
  try {
    const source = cloudwatch({ region: "us-east-1", logGroups: ["g"] }, "t");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[mrn]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("A12345");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[ssn]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("123456789");
  } finally {
    send.mockRestore();
  }
});

it("masks quoted identifiers in SigNoz HTTP and structured error diagnostics", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('member id: "MBR12345"; social security number "123456789"', { status: 500 }));
  vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", "test");
  try {
    const source = signoz({ endpoint: "http://x" }, "t");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[id]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[ssn]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("123456789");
  } finally {
    vi.unstubAllEnvs();
    fetch.mockRestore();
  }
  const source = signoz({ endpoint: "http://x" }, "t", async () => ({ status: "error", error: { message: "Rx # '123456'; ssn: 123456789" } }));
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[rx]");
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[ssn]");
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("123456789");
});
