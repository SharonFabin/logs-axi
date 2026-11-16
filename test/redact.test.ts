import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { isPatientField, maskText, redactObject, redactRecord } from "../src/lib/redact.js";
import { run } from "../src/cli.js";
import { FAKE_PEOPLE, NOW, TEST_CONFIG, cloudwatchResults, cloudwatchStub, events, signozStub } from "./fixtures.js";

describe("patient fields", () => {
  it.each(["residentName", "resident", "patientName", "prescriberName", "firstName", "last_name", "dob", "dateOfBirth", "ssn", "mrn", "phone", "email", "address", "memberId", "rxNumber", "npi", "drugName", "medication", "diagnosis", "room", "patient.dob", "user.email", "residentDob", "senderName", "residentMrn", "patientSsn", "patientMedication", "contactPerson"])(
    "drops %s",
    (k) => expect(isPatientField(k)).toBe(true),
  );
  it.each(["caseId", "residentId", "patientId", "orgId", "facilityId", "requestId", "traceId", "service.name", "host.name", "residentCount", "durationMs", "error", "status", "method", "path", "facilityName"])(
    "keeps %s",
    (k) => expect(isPatientField(k)).toBe(false),
  );

  it("drops nested patient data and counts it, keeping ids", () => {
    const stats = { droppedFields: 0 };
    const out = redactObject(
      { caseId: "3f2a1c9e-1111-4222-8333-444455556666", prescriber: { name: "Dr. Alan Fakename" }, ctx: { residentName: "Jane Testperson", residentId: "r-1" } },
      stats,
    );
    expect(out).toEqual({ caseId: "3f2a1c9e-1111-4222-8333-444455556666", ctx: { residentId: "r-1" } });
    expect(stats.droppedFields).toBe(2);
  });
});

describe("free-text masking", () => {
  it.each([
    ["Resident Jane Testperson not found in roster", "Resident [name]"],
    ["resident: Jane Testperson", "resident: [name]"],
    ['patient="JANE TESTPERSON" mismatch', 'patient="[name]" mismatch'],
    ["Dr. Alan Fakename signed", "Dr [name] signed"],
    ["Prescriber Fakename, Alan rejected order 12", "Prescriber [name] rejected order 12"],
    ["matched TESTPERSON, JANE Q. today", "matched [name] today"],
    ["Case Created for María Plácido", "Case Created for [name]"],
    ["called Maria Placeholder at 813-555-0142", "called [name] at [phone]"],
    ["SMS to +15551234567 failed, retry 5551234567 or 1-555-123-4567", "SMS to [phone] failed, retry [phone] or [phone]"],
    ["Failed to notify Jane McDonald", "Failed to notify [name]"],
    ["Dr McDonald signed", "Dr [name] signed"],
    ["resident: DeShawn MacArthur", "resident: [name]"],
    ["Patient Not Found", "Patient [name]"],
    ["mail jane.t@example.com DOB: 01/05/1950", "mail [email] [dob]"],
    ["MRN: A12345 Rx #1234567 member id ABC12345 room 12B ssn 123-45-6789", "[mrn] [rx] [id] [room] [ssn]"],
  ])("%s", (input, expected) => expect(maskText(input)).toBe(expected));

  it.each([
    "Internal Server Error",
    "TypeError: Cannot read properties of undefined (reading 'id')",
    "payer lookup failed after 3 retries",
    "GET /api/cases/3f2a1c9e-1111-4222-8333-444455556666 returned 502 Bad Gateway",
    "case created",
    "request 123456789 caseId=987654321",
    "caseId=case-1 residentId=resident-1 patientId=patient-1",
    "ECONNREFUSED 10.0.0.12:5432",
  ])("leaves ordinary log text alone: %s", (input) => expect(maskText(input)).toBe(input));

  it("masks names used as map keys", () => {
    expect(redactObject({ byResident: { "Jane Testperson": 3 } }, { droppedFields: 0 })).toEqual({ byResident: { "[name]": 3 } });
  });

  it("masks the message and string fields of a record", () => {
    const r = redactRecord(
      { time: "t", level: "error", service: "ehr-service", msg: "match failed for Jane Testperson", fields: { error: "Resident Jane Testperson missing", n: 3 } },
      { droppedFields: 0 },
    );
    expect(r.msg).toBe("match failed for [name]");
    expect(r.fields).toEqual({ error: "Resident [name]", n: 3 });
  });
});

describe("end to end: no fake person reaches the output", () => {
  const evs = events(300);
  const traced = evs.find((e) => e.fields.residentName)!;
  const wire = JSON.parse(cloudwatchResults([traced]).results[0]!.find((field) => field.field === "@message")!.value!);

  for (const source of ["cloudwatch", "signoz"] as const) {
    const id = source === "cloudwatch" ? wire.caseId : traced.traceId!;
    const commands = [["tail", "--limit", "300"], ["search", "failed", "--limit", "300"], ["errors"], ["trace", id], ["fields"], ["services"]];
    for (const cmd of commands) {
      for (const fmt of [[], ["--json"], ...(["tail", "search", "trace"].includes(cmd[0]!) ? [["--full"]] : [])]) {
        it(`${source} ${cmd[0]} ${fmt.join(" ")}`, async () => {
          const transport = source === "cloudwatch" ? cloudwatchStub(evs) : signozStub(evs);
          const { out, code } = await run([source, "dev", ...cmd, ...fmt], { config: TEST_CONFIG, transports: { [source]: transport }, now: NOW });
          expect(code).toBe(0);
          if (cmd[0] === "trace") {
            const body = fmt.includes("--json") ? JSON.parse(out) : decode(out.split("\nhelp[")[0]!);
            expect(body.lines).toHaveLength(1);
          }
          for (const p of FAKE_PEOPLE) expect(out).not.toContain(p);
          expect(out).not.toContain("1950-01-05");
          expect(out).not.toContain("813-555-0142");
          expect(out).not.toContain("1234567890"); // npi
        });
      }
    }
  }

  it("--unredacted shows the data and warns", async () => {
    const { out } = await run(["cloudwatch", "dev", "tail", "--limit", "300", "--unredacted", "--full"], {
      config: TEST_CONFIG,
      transports: { cloudwatch: cloudwatchStub(evs) },
      now: NOW,
    });
    expect(out.split("\n")[0]).toMatch(/^warning: .*UNREDACTED.*patient data/);
    expect(out).toContain("Jane Testperson");
  });
});
