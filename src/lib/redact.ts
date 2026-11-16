/**
 * Patient-data redaction, on by default. Two layers:
 *
 * 1. Fields: known patient-data keys (names, birth dates, contact details, insurance
 *    numbers, drugs, diagnoses, room/bed) are dropped whole, at any depth. Keys that
 *    are ids (`caseId`, `residentId`), counts and service names stay.
 * 2. Free text: every remaining string (the message included) is masked for direct
 *    identifiers (email, phone, SSN, DOB, MRN, member/Rx numbers) and anything
 *    name-shaped: titled names (`Dr Smith`), labelled names (`resident: Jane Doe`),
 *    `Last, First`, and runs of capitalized words that are not common log vocabulary.
 *
 * It errs toward masking: a capitalized product word may come out as `[name]`, which
 * costs a little meaning; the opposite error puts a resident's name in an agent's
 * context. `--unredacted` turns this off and prints a warning.
 *
 * ponytail: the name heuristics are a denylist of shapes, not de-identification. An
 * all-lowercase name in prose survives. Upgrade path: an allowlist of fields per
 * service, like the monorepo's typed logger, if a leak is ever seen.
 */
import type { LogRecord } from "../core/types.js";

/** Normalized key (lowercase, alphanumerics only) of a field that is always patient data. */
const DROP_EXACT = new Set([
  "name", "names", "fullname", "firstname", "lastname", "middlename", "givenname", "familyname", "surname",
  "displayname", "preferredname", "nickname", "initials",
  "resident", "residents", "patient", "patients", "prescriber", "prescribers", "physician", "doctor",
  "dob", "dateofbirth", "birthdate", "birthday", "age", "gender", "sex",
  "ssn", "socialsecuritynumber", "mrn", "medicalrecordnumber", "chartnumber",
  "phone", "phonenumber", "mobile", "cell", "fax", "email", "emailaddress",
  "address", "street", "streetaddress", "addressline1", "addressline2", "city", "zip", "zipcode", "postalcode",
  "memberid", "membernumber", "subscriberid", "subscribernumber", "policyid", "policynumber", "groupnumber",
  "medicaidid", "medicareid", "mbi", "beneficiaryid", "insuranceid",
  "rx", "rxnumber", "rxno", "npi", "dea",
  "drug", "drugs", "drugname", "medication", "medications", "ndc", "sig", "directions", "dose", "dosage",
  "diagnosis", "diagnoses", "icd10", "icd", "allergy", "allergies",
  "room", "roomnumber", "bed", "bednumber",
]);
/** A key that starts with a person prefix is dropped unless it is an id or a count (`residentDob` goes, `residentId` stays). */
const PERSON_PREFIX = /^(resident|patient|prescriber|physician|doctor|member|subscriber|guardian|caregiver|contact|emergencycontact|nextofkin|recipient|sender)/;
const KEEP_SUFFIX = /(id|ids|count|counts|total)$/;
/** Any key ending in `name` with a person-ish stem: `prescriberName`, `senderName`, `userName`. */
const PERSON_NAME = /(first|last|middle|full|given|family|sur|display|user|person|contact|sender|recipient|provider|prescriber|resident|patient|physician|doctor|member|subscriber|caregiver|guardian|drug|medication)name$/;

/** Fields that are structure, not content: never masked. */
const STRUCTURAL = new Set(["service", "level", "time", "traceId", "spanId", "requestId", "correlationId"]);

export function isPatientField(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (DROP_EXACT.has(k)) return true;
  if (PERSON_NAME.test(k)) return true;
  if (PERSON_PREFIX.test(k) && !KEEP_SUFFIX.test(k)) return true;
  // dotted OTel-style keys: judge the last segment too (`user.email`), but a bare `name` there
  // belongs to its parent (`service.name` stays, `patient.name` went above as `patientname`)
  const last = key.split(/[.\/]/).pop() ?? key;
  if (last !== key && !/^names?$/i.test(last)) return isPatientField(last);
  return false;
}

/** Capitalized words common in log messages; a run made only of these is not a name. */
const COMMON = new Set(
  (
    "a an the and or not no of to in on at by for from with without into over under after before via per is are was were be been " +
    "has have had do does did can cannot could should would will may might must this that these those it its error errors failed " +
    "failure fail timeout timed out request requests response responses server service services internal external bad gateway " +
    "found unavailable unauthorized forbidden conflict too many connection connect refused reset closed open invalid valid missing " +
    "unknown unexpected retry retrying retries attempt attempts started starting start stopped stopping stop complete completed " +
    "done ready running run runs queued pending skipped success succeeded ok warning warn info debug fatal exception type " +
    "reference range syntax access denied permission permissions token tokens session sessions user users org organization " +
    "organizations facility facilities case cases run job jobs task tasks worker workers queue queues event events message " +
    "messages mail email inbox thread threads sync synced syncing poll polling sweep sweeps engine handler handlers invocation " +
    "workflow workflows step steps check checks lookup query queries database db table row rows column record records key keys " +
    "value values field fields file files upload download document documents report reports order orders note notes alert alerts " +
    "deploy deployment release version health healthy unhealthy ping pong get post put patch delete head options http https " +
    "api rest grpc json xml html url uri id ids uuid date time day days hour hours minute minutes second seconds ms new old " +
    "first last next previous current default true false null none empty all any some each every other more less " +
    "read write created updated deleted inserted saved loaded sent received accepted rejected approved denied cancelled canceled " +
    "aws amazon cloudwatch signoz restate postgres prisma node bun lambda ecs fargate sqs sns ses s3 bedrock anthropic openai claude " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october " +
    "november december pending network dns tls ssl certificate socket stream streams body header headers payload limit exceeded " +
    "rate throttled throttling capacity memory disk cpu process signal sigterm sigkill shutdown shutting down graceful drain draining " +
    "fetch fetched parse parsed send load save process processed handle handled create update resolve resolved match matched " +
    "patient patients resident residents prescriber physician nurse member subscriber pcc pharmacy payer ehr comms " +
    "identity notifications assistant crawler medicaid medicare " +
    "unable could cant can't won't doesn't isn't did didn't client clients call calls callback cache cached hit miss"
  ).split(/\s+/),
);

/** A capitalized word, interior capitals included (`McDonald`, `DeShawn`). */
const CAP_WORD = String.raw`\p{Lu}[\p{Ll}'’\-]+(?:\p{Lu}[\p{Ll}'’\-]+)*`;
const UPPER_WORD = String.raw`\p{Lu}{2,}`;
/** Case-insensitive literal without the `i` flag: under `iu`, \p{Lu} would also match lowercase letters. */
const ci = (w: string) => w.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const NAME_LABEL = `(?:${["resident", "patient", "prescriber", "physician", "doctor", "provider", "member", "subscriber", "caregiver", "guardian", "sender", "recipient", "full ?name", "first ?name", "last ?name", "name"].map(ci).join("|")})`;

const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\+\d{10,15}(?!\d)/g, "[phone]"],
  [/(?<![\w.])(?:1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?![\w.])/g, "[phone]"],
  [/\b(?:DOB|D\.O\.B\.?|date of birth|birth ?date)\s*[:=#]?\s*\S+(?:\s+\d{1,2},?\s+\d{2,4})?/gi, "[dob]"],
  [/\b(?:MRN|MR#|medical record(?: number)?)(?![A-Za-z])\s*[:=#]?\s*[A-Z0-9-]+/gi, "[mrn]"],
  [/\bRx\s*(?:#|no\.?|num(?:ber)?)?\s*[:=#]?\s*\d[\d-]{3,}\d\b/gi, "[rx]"],
  [
    /\b(?:member|subscriber|policy|medicaid|medicare|mbi|beneficiary|insurance)\s*(?:id|#|no\.?|num(?:ber)?)\s*[:=#]?\s*[A-Z0-9][A-Z0-9-]{3,}/gi,
    "[id]",
  ],
  [/\b(?:room|rm\.?|bed)\s*#?\s*\d+[A-Z]?\b/gi, "[room]"],
  // Dr Smith, Mrs. Jane Doe, NP Jones
  [
    new RegExp(String.raw`\b(Dr|Doctor|Mr|Mrs|Ms|Miss|Mx|Prof|Nurse|NP|RN|LPN|PA)\.?\s+${CAP_WORD}(?:\s+${CAP_WORD})?`, "gu"),
    (_m: string, title: string) => `${title} [name]`,
  ],
  // resident: Jane Doe / patient="JOHN SMITH" / name=Smith
  [
    new RegExp(String.raw`\b(${NAME_LABEL})(\s*[:=]\s*|\s+)(["']?)((?:${CAP_WORD}|${UPPER_WORD})(?:[\s,]+(?:${CAP_WORD}|${UPPER_WORD}|\p{Lu}\.))*)\3`, "gu"),
    (m: string, label: string, sep: string, q: string, name: string) =>
      // after `:`/`=` the value is a name whatever it says; after a space only if it is not ordinary words
      /[:=]/.test(sep) || nameUnlessCommon(name) !== name ? `${label}${sep}${q}[name]${q}` : m,
  ],
  // Smith, Jane / SMITH, JANE
  [new RegExp(String.raw`\b(?:${CAP_WORD}|${UPPER_WORD}),\s?(?:${CAP_WORD}|${UPPER_WORD})(?:\s\p{Lu}\.?)?(?![\p{L}])`, "gu"), nameUnlessCommon],
  // Jane Doe, Jane Q. Doe, JANE DOE
  [
    new RegExp(String.raw`\b(?:${CAP_WORD}|${UPPER_WORD})(?:\s+\p{Lu}\.)?(?:\s+(?:${CAP_WORD}|${UPPER_WORD})){1,2}(?![\p{L}])`, "gu"),
    nameUnlessCommon,
  ],
];

/** A run of capitalized words is a name unless every word is common vocabulary. */
function nameUnlessCommon(m: string): string {
  const words = m.split(/[\s,.]+/).filter(Boolean);
  if (words.every((w) => COMMON.has(w.toLowerCase()) || w.length === 1)) return m;
  return "[name]";
}

/** Fold accents so `García` is matched like `Garcia`. */
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "");

export function maskText(text: string): string {
  let out = fold(text);
  for (const [re, to] of RULES) out = out.replace(re, to as never);
  return out;
}

export interface RedactStats {
  droppedFields: number;
}

function redactValue(v: unknown, stats: RedactStats): unknown {
  if (typeof v === "string") return maskText(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, stats));
  if (v && typeof v === "object") return redactObject(v as Record<string, unknown>, stats);
  return v;
}

export function redactObject(obj: Record<string, unknown>, stats: RedactStats): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isPatientField(k)) {
      stats.droppedFields++;
      continue;
    }
    // a map keyed by people (`{ byResident: { "Jane Doe": 3 } }`) puts the name in the key
    out[STRUCTURAL.has(k) ? k : maskText(k)] = STRUCTURAL.has(k) ? v : redactValue(v, stats);
  }
  return out;
}

export function redactRecord(r: LogRecord, stats: RedactStats): LogRecord {
  return { ...r, msg: maskText(r.msg), fields: redactObject(r.fields, stats) };
}
