import { getPath } from "./paths";

export interface Check {
  ok: boolean;
  message: string;
}

const isOperatorObject = (m: unknown): m is Record<string, unknown> =>
  !!m && typeof m === "object" && !Array.isArray(m) &&
  Object.keys(m as object).every((k) => ["equals", "contains", "matches", "exists", "gt", "gte", "lt", "lte", "one_of", "includes_all", "any_equal", "none_equal", "all_equal", "length"].includes(k));

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/** Evaluate one expectation (scalar shorthand or operator object) against the values found at `path`. */
export function check(root: unknown, path: string, matcher: unknown): Check {
  const { values, wildcard } = getPath(root, path);
  const ops: Record<string, unknown> = isOperatorObject(matcher) ? matcher : { equals: matcher };
  const results: Check[] = [];
  const single = values[0];

  for (const [op, expected] of Object.entries(ops)) {
    switch (op) {
      case "exists": {
        const exists = values.length > 0;
        results.push({ ok: exists === expected, message: `${path} ${exists ? "exists" : "is missing"}` });
        break;
      }
      case "equals": {
        if (wildcard) results.push({ ok: values.length > 0 && values.every((v) => deepEqual(v, expected)), message: `all ${path} = ${show(expected)} (got ${show(values)})` });
        else results.push({ ok: values.length > 0 && deepEqual(single, expected), message: `${path} = ${show(expected)} (got ${show(single)})` });
        break;
      }
      case "all_equal":
        results.push({ ok: values.length > 0 && values.every((v) => deepEqual(v, expected)), message: `all ${path} = ${show(expected)} (got ${show(values)})` });
        break;
      case "any_equal":
        results.push({ ok: values.some((v) => deepEqual(v, expected)), message: `some ${path} = ${show(expected)} (got ${show(values)})` });
        break;
      case "none_equal":
        results.push({ ok: !values.some((v) => deepEqual(v, expected)), message: `no ${path} = ${show(expected)} (got ${show(values)})` });
        break;
      case "includes_all": {
        const pool = wildcard ? values : Array.isArray(single) ? (single as unknown[]) : values;
        const missing = (expected as unknown[]).filter((e) => !pool.some((v) => deepEqual(v, e)));
        results.push({ ok: missing.length === 0, message: `${path} includes ${show(expected)} (missing ${show(missing)}; got ${show(pool)})` });
        break;
      }
      case "contains": {
        const has = (v: unknown): boolean =>
          typeof v === "string" ? v.toLowerCase().includes(String(expected).toLowerCase())
          : Array.isArray(v) ? v.some((x) => deepEqual(x, expected) || (typeof x === "string" && typeof expected === "string" && x.toLowerCase().includes(expected.toLowerCase())))
          : false;
        const ok = wildcard ? values.some(has) : has(single);
        results.push({ ok, message: `${path} contains ${show(expected)} (got ${show(wildcard ? values : single)})` });
        break;
      }
      case "matches":
        results.push({ ok: typeof single === "string" && new RegExp(String(expected), "i").test(single), message: `${path} matches /${String(expected)}/ (got ${show(single)})` });
        break;
      case "one_of":
        results.push({ ok: (expected as unknown[]).some((e) => deepEqual(e, single)), message: `${path} in ${show(expected)} (got ${show(single)})` });
        break;
      case "length": {
        const len = Array.isArray(single) ? single.length : wildcard ? values.length : undefined;
        results.push({ ok: len === expected, message: `${path} length ${show(expected)} (got ${show(len)})` });
        break;
      }
      case "gt": case "gte": case "lt": case "lte": {
        const n = Number(single);
        const e = Number(expected);
        const ok = Number.isFinite(n) && (op === "gt" ? n > e : op === "gte" ? n >= e : op === "lt" ? n < e : n <= e);
        results.push({ ok, message: `${path} ${op} ${e} (got ${show(single)})` });
        break;
      }
    }
  }
  const failed = results.filter((r) => !r.ok);
  return failed.length ? { ok: false, message: `expected ${failed.map((f) => f.message).join("; ")}` } : { ok: true, message: results.map((r) => r.message).join("; ") };
}
