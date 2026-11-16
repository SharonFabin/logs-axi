type Token = { kind: string; value: any };

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'" || c === "/") {
      const quote = c;
      let value = "";
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") {
          if (quote === "/") value += text[i++];
          else i++;
        }
        value += text[i++];
      }
      i++;
      out.push({ kind: "literal", value: quote === "/" ? new RegExp(value.replace("(?i)", ""), value.includes("(?i)") ? "i" : "") : value });
    } else if (/[(),\[\]=]/.test(c)) { out.push({ kind: c, value: c }); i++; }
    else {
      const word = /^[\w@.\-]+/.exec(text.slice(i))?.[0];
      if (!word) throw new Error(`unexpected query token: ${text.slice(i)}`);
      out.push({ kind: /^\d+$/.test(word) ? "literal" : "word", value: /^\d+$/.test(word) ? Number(word) : word });
      i += word.length;
    }
  }
  return out;
}

class ContextValues {
  constructor(readonly values: unknown[]) {}
}

export function evaluate(expression: string, fields: Record<string, unknown>): any {
  const input = tokens(expression);
  let at = 0;
  const is = (word: string) => String(input[at]?.value).toLowerCase() === word;
  const take = (word: string) => { if (!is(word)) throw new Error(`expected ${word} at ${input[at]?.value}`); at++; };
  const read = (value: any, key: string): any => {
    if (value && Object.hasOwn(value, key)) return value[key];
    for (const part of key.split(".")) value = value?.[part];
    return value;
  };
  const lookup = (key: string): any => {
    if (Object.hasOwn(fields, key)) return fields[key];
    const [root, ...path] = key.split(".");
    if (root === "body" && path.length) {
      let value: any = (fields.log as any)?.body ?? fields.body;
      if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return undefined; }
      }
      const scalar = read(value, path.join("."));
      if (scalar === undefined) return undefined;
      return scalar === null || typeof scalar === "object" ? "" : String(scalar);
    }
    if (["attribute", "resource", "log"].includes(root!) && path.length) {
      return read(fields[root!] ?? (fields.log || fields.attribute || fields.resource ? {} : fields), path.join("."));
    }
    const resource = read(fields.resource, key);
    const attribute = read(fields.attribute, key);
    if (resource !== undefined && attribute !== undefined) return resource;
    const values = [resource, attribute, read(fields.log, key)].filter((value) => value !== undefined);
    if (values.length > 1) return new ContextValues(values);
    return values[0];
  };
  const primary = (): any => {
    if (is("not")) { at++; return !primary(); }
    if (is("(")) { at++; const value = or(); take(")"); return value; }
    const t = input[at++];
    if (!t) throw new Error("missing query operand");
    if (t.kind === "literal") return t.value;
    return lookup(t.value);
  };
  const compare = (): any => {
    const left = primary();
    let negated = false;
    if (is("not")) { at++; negated = true; }
    const op = String(input[at]?.value).toLowerCase();
    const apply = (test: (value: any) => boolean) => {
      const values = left instanceof ContextValues ? left.values : [left];
      return values.some((value) => negated ? !test(value) : test(value));
    };
    if (op === "exists") { at++; return apply((value) => value !== undefined && value !== null); }
    if (op === "in") {
      at++;
      const close = is("[") ? "]" : ")";
      at++;
      const choices: any[] = [];
      while (!is(close)) { choices.push(primary()); if (!is(",")) break; at++; }
      take(close);
      return apply((value) => choices.includes(value));
    }
    if (["=", "like", "regexp", "contains"].includes(op)) {
      at++;
      const right = primary();
      return apply((value) => op === "=" ? value === right : op === "contains" ? String(value ?? "").toLowerCase().includes(String(right).toLowerCase())
        : right instanceof RegExp ? right.test(String(value ?? ""))
        : op === "regexp" ? new RegExp(right.replace("(?i)", ""), right.includes("(?i)") ? "i" : "").test(String(value ?? ""))
        : String(value ?? "").includes(right));
    }
    if (negated) throw new Error("unconsumed NOT");
    return left;
  };
  const and = (): any => { let value = compare(); while (is("and")) { at++; const right = compare(); value = value && right; } return value; };
  const or = (): any => { let value = and(); while (is("or")) { at++; const right = and(); value = value || right; } return value; };
  const value = or();
  if (at !== input.length) throw new Error(`unconsumed query: ${input.slice(at).map((t) => t.value).join(" ")}`);
  return value;
}

export function insightsFields(query: string, fields: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const line of query.split("\n")) {
    if (line.startsWith("| filter ") && !evaluate(line.slice(9), fields)) return undefined;
  }
  return fields;
}
