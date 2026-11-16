/**
 * Patient-data redaction; the user-facing contract lives in README.md#redaction.
 *
 * It errs toward masking: a capitalized product word may come out as `[name]`, which
 * costs a little meaning; the opposite error puts a resident's name in an agent's
 * context.
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
].map(singularKey));
/** A key that starts with a person prefix is dropped unless it is an id or a count (`residentDob` goes, `residentId` stays). */
const PERSON_PREFIX = /^(resident|patient|prescriber|physician|doctor|member|subscriber|guardian|caregiver|contact|emergencycontact|nextofkin|recipient|sender)/;
const KEEP_SUFFIX = /(id|ids|count|counts|total)$/;
/** Any key ending in `name` with a person-ish stem: `prescriberName`, `senderName`, `userName`. */
const PERSON_NAME = /(first|last|middle|full|given|family|sur|display|user|person|contact|sender|recipient|provider|prescriber|resident|patient|physician|doctor|member|subscriber|caregiver|guardian|drug|medication)name$/;

/** Fields that are structure, not content: never masked. */
const STRUCTURAL = new Set(["service", "level", "time", "traceId", "spanId", "requestId", "correlationId"]);

function singularKey(key: string): string {
  if (key.endsWith("ies")) return key.slice(0, -3) + "y";
  if (/(?:sses|xes|zes|ches|shes)$/.test(key)) return key.slice(0, -2);
  if (/s$/.test(key) && !/(?:ss|sis|us)$/.test(key)) return key.slice(0, -1);
  return key;
}

export function isPatientField(key: string): boolean {
  const parts = key.split(/[.\/:]+/).filter(Boolean).map((part) => singularKey(part.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const last = parts.at(-1) ?? "";
  const k = parts.join("");
  const protectedKey = (value: string) => {
    if (DROP_EXACT.has(value) || PERSON_NAME.test(value)) return true;
    if (!PERSON_PREFIX.test(value)) return false;
    if (DROP_EXACT.has(value.replace(PERSON_PREFIX, ""))) return true;
    return !KEEP_SUFFIX.test(value);
  };
  return protectedKey(k) || (last !== "name" && protectedKey(last));
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

const labelledValue = (label: string, value: string) => new RegExp(String.raw`\b(?:${label})\s*[:=#]?\s*(?:"${value}"|'${value}'|${value})`, "gi");

const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]"],
  [labelledValue(String.raw`SSN(?![A-Za-z])|social[ -]security[ -]number(?![A-Za-z])`, String.raw`(?:\d{9}|\d{3}-\d{2}-\d{4})\b`), "[ssn]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\+\d{10,15}(?!\d)/g, "[phone]"],
  [/(?<![\w.])(?:1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?![\w.])/g, "[phone]"],
  [labelledValue(String.raw`DOB|D\.O\.B\.?|date of birth|birth ?date`, String.raw`[^\s"';,]+(?:\s+\d{1,2},?\s+\d{2,4})?`), "[dob]"],
  [labelledValue(String.raw`MRN(?![A-Za-z])|MR#|medical record(?: number)?(?![A-Za-z])`, String.raw`[A-Z0-9-]+`), "[mrn]"],
  [labelledValue(String.raw`Rx\s*(?:#|no\.?|num(?:ber)?)?`, String.raw`\d[\d-]{3,}\d\b`), "[rx]"],
  [labelledValue(String.raw`(?:member|subscriber|policy|medicaid|medicare|mbi|beneficiary|insurance)\s*(?:id|#|no\.?|num(?:ber)?)`, String.raw`[A-Z0-9][A-Z0-9-]{3,}`), "[id]"],
  [labelledValue(String.raw`room|rm\.?|bed`, String.raw`\d+[A-Z]?\b`), "[room]"],
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

export function maskText(text: string, stats: RedactStats = { droppedFields: 0 }): string {
  if (text.trim().startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(text);
      if (typeof decoded === "string") return JSON.stringify(maskText(decoded, stats));
    } catch {}
  }
  const mask = (s: string) => {
    let out = fold(s);
    for (const [re, to] of RULES) out = out.replace(re, to as never);
    return out;
  };
  let out = "";
  let from = 0;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const c = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth--;
      if (depth !== 0 || quoted) continue;
      let value: unknown;
      try {
        value = JSON.parse(text.slice(start, end + 1));
      } catch {
        break;
      }
      out += mask(text.slice(from, start)) + JSON.stringify(redactValue(value, stats));
      from = end + 1;
      start = end;
      break;
    }
  }
  return out + mask(text.slice(from));
}

export interface RedactStats {
  droppedFields: number;
}

function redactValue(v: unknown, stats: RedactStats): unknown {
  if (typeof v === "string") return maskText(v, stats);
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
    const base = STRUCTURAL.has(k) ? k : maskText(k, stats);
    let key = base;
    let suffix = 2;
    while (Object.hasOwn(out, key)) key = `${base}#${suffix++}`;
    Object.defineProperty(out, key, { value: STRUCTURAL.has(k) && typeof v === "string" && !/^[\s]*[\[{"]/.test(v) ? v : redactValue(v, stats), enumerable: true, configurable: true, writable: true });
  }
  return out;
}

export function redactRecord(r: LogRecord, stats: RedactStats): LogRecord {
  return { ...r, msg: maskText(r.msg, stats), fields: redactObject(r.fields, stats) };
}
