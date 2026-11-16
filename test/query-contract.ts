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

export function evaluate(expression: string, fields: Record<string, unknown>): any {
  const input = tokens(expression);
  let at = 0;
  const is = (word: string) => String(input[at]?.value).toLowerCase() === word;
  const take = (word: string) => { if (!is(word)) throw new Error(`expected ${word} at ${input[at]?.value}`); at++; };
  const lookup = (key: string) => {
    if (Object.hasOwn(fields, key)) return fields[key];
    const [root, ...path] = key.split(".");
    let value: any = fields[root!];
    if (root === "body" && path.length && typeof value === "string") {
      try { value = JSON.parse(value); } catch { return undefined; }
    }
    for (const part of path) value = value?.[part];
    return value;
  };
  const primary = (): any => {
    if (is("not")) { at++; return !primary(); }
    if (is("(")) { at++; const value = or(); take(")"); return value; }
    const t = input[at++];
    if (!t) throw new Error("missing query operand");
    if (t.kind === "literal") return t.value;
    if (is("(")) {
      at++;
      const args: any[] = [];
      while (!is(")")) {
        args.push(or());
        if (!is(",")) break;
        at++;
      }
      take(")");
      switch (t.value.toLowerCase()) {
        case "case": {
          if (Math.floor(args.length / 2) > 10) throw new Error("CloudWatch case supports at most 10 branches");
          for (let i = 0; i + 1 < args.length; i += 2) if (args[i]) return args[i + 1];
          return args.length % 2 ? args.at(-1) : undefined;
        }
        case "coalesce": return args.find((v) => v !== undefined && v !== null);
        case "tolower": return typeof args[0] === "string" ? args[0].toLowerCase() : undefined;
        case "isempty": return args[0] === undefined || args[0] === null || args[0] === "" ? 1 : 0;
        case "ispresent": return args[0] !== undefined && args[0] !== null;
        default: throw new Error(`unknown query function ${t.value}`);
      }
    }
    return lookup(t.value);
  };
  const compare = (): any => {
    const left = primary();
    let negated = false;
    if (is("not")) { at++; negated = true; }
    const op = String(input[at]?.value).toLowerCase();
    let value: boolean;
    if (op === "exists") { at++; value = left !== undefined && left !== null; }
    else if (op === "in") {
      at++;
      const close = is("[") ? "]" : ")";
      at++;
      const choices: any[] = [];
      while (!is(close)) { choices.push(primary()); if (!is(",")) break; at++; }
      take(close);
      value = choices.includes(left);
    } else if (["=", "like", "regexp", "contains"].includes(op)) {
      at++;
      const right = primary();
      value = op === "=" ? left === right : op === "contains" ? String(left ?? "").includes(right)
        : right instanceof RegExp ? right.test(String(left ?? ""))
        : op === "regexp" ? new RegExp(right.replace("(?i)", ""), right.includes("(?i)") ? "i" : "").test(String(left ?? ""))
        : String(left ?? "").includes(right);
    } else {
      if (negated) throw new Error("unconsumed NOT");
      return left;
    }
    return negated ? !value : value;
  };
  const and = (): any => { let value = compare(); while (is("and")) { at++; const right = compare(); value = value && right; } return value; };
  const or = (): any => { let value = and(); while (is("or")) { at++; const right = and(); value = value || right; } return value; };
  const value = or();
  if (at !== input.length) throw new Error(`unconsumed query: ${input.slice(at).map((t) => t.value).join(" ")}`);
  return value;
}

export function insightsFields(query: string, fields: Record<string, unknown>): Record<string, unknown> | undefined {
  const out = { ...fields };
  for (const line of query.split("\n")) {
    if (line.startsWith("| fields ")) {
      const assignment = /^\| fields (.*) as (\w+)$/.exec(line);
      if (assignment && !assignment[1]!.includes(" as ")) out[assignment[2]!] = evaluate(assignment[1]!, out);
    }
    if (line.startsWith("| filter ") && !evaluate(line.slice(9), out)) return undefined;
  }
  return out;
}
