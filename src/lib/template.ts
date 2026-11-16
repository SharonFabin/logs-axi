/**
 * A message's template: the variable parts (ids, numbers, times, URLs, IP addresses)
 * replaced by placeholders, so one failure repeated 400 times with 400 case ids is
 * one group. Runs after redaction, so `[name]` and friends are already placeholders.
 */
const RULES: [RegExp, string][] = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<time>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\bhttps?:\/\/[^\s"'<>)]+/g, "<url>"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>"],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<hex>"],
  // prefixed ids: inv_1abc, case_01HX..., req-8f2k
  [/\b[a-z]{2,8}[_-](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,}\b/g, "<id>"],
  // a number glued to a unit counts too (`431ms`), one inside a word does not (`v2`, `s3`)
  [/(?<![\p{L}\d_.])-?\d+(?:\.\d+)?/gu, "<n>"],
];

export const TEMPLATE_MAX = 160;

export function template(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > TEMPLATE_MAX ? out.slice(0, TEMPLATE_MAX) + "…" : out;
}
