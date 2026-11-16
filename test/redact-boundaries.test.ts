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
    if (quote) it(`masks ${label} ${quote}${value} without a closing value quote`, () => {
      for (const suffix of ["", "; requestId=987654321 caseId=case-1"]) {
        expect(maskText(`failed ${label} ${quote}${value}${suffix}`)).toBe(`failed ${replacement}${suffix}`);
      }
    });
  }
});

it.each([
  ...["resident", "patient", "prescriber", "physician", "doctor", "provider", "member", "subscriber", "caregiver", "guardian", "sender", "recipient", "full name", "fullname", "first name", "firstname", "last name", "lastname", "name"].map((label) => [label, "Jane", "[name]"]),
  ["ssn", "123456789", "[ssn]"], ["social security number", "123456789", "[ssn]"],
  ["dob", "1950-01-05", "[dob]"], ["birthdate", "1950-01-05", "[dob]"],
  ["mrn", "A12345", "[mrn]"], ["medical record number", "A12345", "[mrn]"],
  ["rxNumber", "123456", "[rx]"],
  ...["member", "subscriber", "policy", "medicaid", "medicare", "mbi", "beneficiary", "insurance"].map((label) => [`${label}Id`, "MBR12345", "[id]"]),
  ["room", "12B", "[room]"], ["bed", "12B", "[room]"],
])("protects %s in every label/value representation", (label, value, replacement) => {
  const ids = '"requestId":"987654321","caseId":"case-1"';
  const fragments = [
    ...[":", "=", " "].map((separator) => `lookup failed ${label}${separator}${value}; ${ids}`),
    ...['"', "'"].flatMap((keyQuote) => ['"', "'", ""].flatMap((valueQuote) => [
      `lookup failed ${keyQuote}${label}${keyQuote}:${valueQuote}${value}${valueQuote}; ${ids}`,
      `lookup failed {${ids},${keyQuote}${label}${keyQuote}:${valueQuote}${value}${valueQuote}`,
      `lookup failed {${ids},${keyQuote}${label}${keyQuote}:${valueQuote}${value}`,
    ])),
    `lookup failed ${JSON.stringify({ requestId: "987654321", caseId: "case-1", [label]: value })}`,
  ];
  for (const fragment of fragments) {
    const output = maskText(fragment);
    expect(output).not.toContain(value);
    expect(output).toContain('"requestId":"987654321"');
    expect(output).toContain('"caseId":"case-1"');
    if (!fragment.endsWith("}")) expect(output).toContain(replacement);
  }
  if (replacement === "[name]") for (const name of ["jane", "Jane de Silva", "O'Brien", "Smith, Jane"]) {
    for (const close of ['"', ""]) {
      expect(maskText(`lookup failed {${ids},"${label}":"${name}${close}`)).not.toContain(name);
    }
  }
});

it.each([
  ["ssn", "123456789", "[ssn]"], ["social security number", "123456789", "[ssn]"],
  ["dob", "1950-01-05", "[dob]"], ["date of birth", "01/05/1950", "[dob]"],
  ["mrn", "A12345", "[mrn]"], ["medical record number", "A12345", "[mrn]"],
  ["rxNumber", "123456", "[rx]"],
  ...["member", "subscriber", "policy", "medicaid", "medicare", "beneficiary", "insurance"].map((key) => [`${key}Id`, "MBR12345", "[id]"]),
  ["room", "12B", "[room]"], ["bed", "12B", "[room]"],
])("masks quoted %s keys in complete and truncated JSON while keeping operational IDs", (key, value, replacement) => {
  for (const keyQuote of ['"', "'"]) for (const valueQuote of ['"', "'", ""]) for (const close of ["}", ""]) {
    const input = `request failed {${keyQuote}${key}${keyQuote}:${valueQuote}${value}${valueQuote},"requestId":"987654321","caseId":"case-1"${close}`;
    const output = maskText(input);
    expect(output).not.toContain(value);
    expect(output).toContain('"requestId":"987654321"');
    expect(output).toContain('"caseId":"case-1"');
    if (keyQuote === '"' && valueQuote === '"' && close) {
      expect(output).toBe('request failed {"requestId":"987654321","caseId":"case-1"}');
    } else if (!close || keyQuote === "'" || valueQuote === "'") {
      expect(output).toContain(replacement);
    }
  }
  for (const keyQuote of ['"', "'"]) for (const valueQuote of ['"', "'"]) for (const suffix of ["", ',"requestId":"987654321","caseId":"case-1"']) {
    const prefix = 'request failed {"requestId":"987654321","caseId":"case-1",';
    expect(maskText(`${prefix}${keyQuote}${key}${keyQuote}:${valueQuote}${value}${suffix}`)).toBe(`${prefix}${replacement}${suffix}`);
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
  const event = { ...events(1)[0]!, level: "error", msg: 'failed {"patient":"Jane","mrn":"A12345","ssn":"123456789', fields: {
    caseId: "case-1", medicationNames: ["apixaban"], providerNames: ["PROTECTEDVALUE"], "ctx:userNames": ["PROTECTEDVALUE"],
    details: JSON.stringify({ personNames: ["PROTECTEDVALUE"], message: 'failed {"memberId":"MBR12345","social security number":"123456789","provider":"Jane' }),
    error: 'failed {"rxNumber":"123456","ssn":"123456789","sender":"Jane', note: 'failed {"bed":"12B","ssn":"123456789","recipient":"Jane',
    counts: { 'failed {"ssn":"123456789","caregiver":"Jane': 1 }, requestId: "987654321",
  } };
  const deps = { config: TEST_CONFIG, now: NOW, transports: { [source]: source === "cloudwatch" ? cloudwatchStub([event]) : signozStub([event]) } };
  for (const command of [["tail", "--full"], ["search", "failed", "--full"], ["trace", "case-1", "--full"], ["errors"], ["fields"]]) {
    const result = await run([source, "dev", ...command, "--json"], deps);
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/A12345|MBR12345|123456|12B|PROTECTEDVALUE|apixaban|Jane/);
    const output = JSON.parse(result.out);
    if (output.lines !== undefined || output.fields !== undefined) expect(result.out).toContain("987654321");
    if (output.lines !== undefined) expect(output.lines).toHaveLength(1);
    if (output.groups !== undefined) expect(output.groups).toHaveLength(1);
    if (output.fields !== undefined) expect(output.fields.some((field: any) => field.field === "caseId")).toBe(true);
  }
});

it("masks quoted identifiers in AWS SDK diagnostics", async () => {
  const send = vi.spyOn(CloudWatchLogsClient.prototype, "send").mockRejectedValue(new Error('failed {"mrn":"A12345","ssn":"123456789","patient":"Jane'));
  try {
    const source = cloudwatch({ region: "us-east-1", logGroups: ["g"] }, "t");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[mrn]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("A12345");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[ssn]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("123456789");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("Jane");
  } finally {
    send.mockRestore();
  }
});

it("masks quoted identifiers in SigNoz HTTP and structured error diagnostics", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('failed {"memberId":"MBR12345","social security number":"123456789","patient":"Jane', { status: 500 }));
  vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", "test");
  try {
    const source = signoz({ endpoint: "http://x" }, "t");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[id]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[ssn]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("123456789");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("Jane");
  } finally {
    vi.unstubAllEnvs();
    fetch.mockRestore();
  }
  const source = signoz({ endpoint: "http://x" }, "t", async () => ({ status: "error", error: { message: 'failed {"rxNumber":"123456","ssn":"123456789","patient":"Jane' } }));
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[rx]");
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[ssn]");
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("123456789");
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("Jane");
});
