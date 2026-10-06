/** Minimal JSON path: `a.b[0].c[*].d`. Returns every value matched (wildcards fan out). */

export interface PathResult {
  values: unknown[];
  /** True when the path contained `[*]` (so `values` is a list of matches, not a single value). */
  wildcard: boolean;
}

const SEGMENT = /([^.[\]]+)|\[(\*|\d+)\]/g;

export function getPath(root: unknown, path: string): PathResult {
  let current: unknown[] = [root];
  let wildcard = false;
  for (const m of path.matchAll(SEGMENT)) {
    const key = m[1];
    const idx = m[2];
    const next: unknown[] = [];
    for (const v of current) {
      if (v === undefined || v === null) continue;
      if (key !== undefined) {
        if (typeof v === "object" && key in (v as Record<string, unknown>)) next.push((v as Record<string, unknown>)[key]);
      } else if (idx === "*") {
        wildcard = true;
        if (Array.isArray(v)) next.push(...v);
      } else if (Array.isArray(v) && Number(idx) < v.length) {
        next.push(v[Number(idx)]);
      }
    }
    current = next;
  }
  return { values: current, wildcard };
}

/** `${name}` and `${a.b}` interpolation against a variable bag; whole-string refs keep their type. */
export function interpolate<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === "string") {
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole) {
      const r = getPath(vars, whole[1]!.trim());
      if (r.values.length) return r.values[0] as T;
    }
    return value.replace(/\$\{([^}]+)\}/g, (_, p: string) => {
      const r = getPath(vars, p.trim());
      return r.values.length ? String(r.values[0]) : "";
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolate(v, vars)])) as T;
  }
  return value;
}
