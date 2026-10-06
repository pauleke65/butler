import type { CallRecord } from "../mcp/types";
import type { RoutingDebug } from "../brain/types";
import { check } from "./assert";
import { getPath, interpolate } from "./paths";
import type { Script, Step, WaitUntil } from "./script";

export interface TurnOutcome {
  spoken: string;
  calls: CallRecord[];
  routing?: RoutingDebug;
}

/** What the runner needs from its environment. The CLI and the browser UI each provide one. */
export interface Driver {
  /** Default server id for direct tool calls (`wait_until`, `call`). */
  defaultServer: string;
  say(utterance: string): Promise<TurnOutcome>;
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<CallRecord>;
  setDevice(device: string): Promise<void> | void;
  sleep(ms: number): Promise<void>;
}

export interface StepResult {
  index: number;
  label: string;
  status: "pass" | "fail";
  ms: number;
  details: string[];
  spoken?: string;
  tools?: string[];
}

export interface RunReport {
  name?: string;
  results: StepResult[];
  passed: number;
  failed: number;
  ok: boolean;
  totalMs: number;
}

export interface RunOptions {
  bail?: boolean;
  onStep?: (r: StepResult, step: Step) => void;
  onStepStart?: (index: number, step: Step) => void;
  signal?: AbortSignal;
}

function asList(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function entries(e: Step["expect"]): Array<[string, unknown]> {
  if (!e) return [];
  return (Array.isArray(e) ? e : [e]).flatMap((m) => Object.entries(m));
}

/** Paths are rooted at the call record (`structuredContent`, `content`, `isError`, `_meta`, `args`) or, if bare, at structuredContent. */
export function recordRoot(rec: CallRecord): Record<string, unknown> {
  return {
    structuredContent: rec.result?.structuredContent,
    content: rec.result?.content,
    isError: rec.result?.isError ?? false,
    _meta: rec.result?._meta,
    args: rec.args,
    tool: rec.tool,
    server: rec.server,
  };
}

const ROOT_KEYS = /^(structuredContent|content|isError|_meta|args|tool|server)(?=$|[.[])/;

export function evalPath(rec: CallRecord, path: string) {
  const root = ROOT_KEYS.test(path) ? recordRoot(rec) : rec.result?.structuredContent;
  return root;
}

function stepLabel(step: Step): string {
  if (step.name) return step.name;
  if (step.say) return `say: ${step.say}`;
  if (step.wait_until) return `wait_until ${step.wait_until.tool} ${step.wait_until.path}`;
  if (step.device) return `device: ${step.device}`;
  if (step.call) return `call: ${step.call.tool}`;
  return `sleep ${step.sleep_s}s`;
}

const OPERATOR_KEYS = ["equals", "contains", "matches", "exists", "gt", "gte", "lt", "lte", "one_of", "includes_all", "any_equal", "none_equal", "all_equal", "length"] as const;

function waitMatcher(w: WaitUntil): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const k of OPERATOR_KEYS) if (w[k] !== undefined) m[k] = w[k];
  if (!Object.keys(m).length) m.exists = true;
  return m;
}

export async function runScript(script: Script, driver: Driver, opts: RunOptions = {}): Promise<RunReport> {
  const vars: Record<string, unknown> = {};
  const results: StepResult[] = [];
  const t0 = Date.now();
  const defaultServer = script.server ?? driver.defaultServer;
  if (script.device) await driver.setDevice(script.device);

  for (const [i, step] of script.steps.entries()) {
    if (opts.signal?.aborted) break;
    opts.onStepStart?.(i, step);
    const started = Date.now();
    const details: string[] = [];
    let ok = true;
    let spoken: string | undefined;
    let tools: string[] | undefined;
    const fail = (msg: string) => {
      ok = false;
      details.push(msg);
    };

    try {
      if (step.say !== undefined) {
        const turn = await driver.say(step.say);
        spoken = turn.spoken;
        tools = turn.calls.map((c) => c.tool);
        const wanted = asList(step.expect_tool);
        for (const w of wanted) {
          if (!tools.includes(w)) fail(`expected tool ${w} to be called, got [${tools.join(", ") || "none"}] (spoken: "${turn.spoken}"${turn.routing ? `, routing: ${turn.routing.reason}` : ""})`);
        }
        const target: CallRecord | undefined =
          (wanted.length ? [...turn.calls].reverse().find((c) => c.tool === wanted[0]) : undefined) ?? turn.calls[turn.calls.length - 1];
        const needsCall = step.expect || step.expect_args || step.save;
        if (needsCall && !target) fail("no tool call was made, cannot evaluate expectations");
        if (target) {
          if (target.error) fail(`tool ${target.tool} failed: ${target.error}`);
          for (const [path, matcher] of entries(step.expect)) {
            const c = check(evalPath(target, path), path, interpolate(matcher, vars));
            if (!c.ok) fail(c.message);
          }
          for (const [path, matcher] of entries(step.expect_args)) {
            const c = check(target.args, path, interpolate(matcher, vars));
            if (!c.ok) fail(`args: ${c.message}`);
          }
          for (const [name, path] of Object.entries(step.save ?? {})) {
            const r = getPath(evalPath(target, path), path);
            if (r.values.length) vars[name] = r.values[0];
            else fail(`save ${name}: path ${path} not found`);
          }
        }
        for (const s of [...asList(step.expect_spoken), ...asList(step.expect_spoken_contains)]) {
          if (!turn.spoken.toLowerCase().includes(s.toLowerCase())) fail(`spoken reply should contain "${s}" (got "${turn.spoken}")`);
        }
        if (ok) details.push(`tool=${tools.join(",") || "none"}`);
      } else if (step.wait_until) {
        const w = step.wait_until;
        const server = w.server ?? defaultServer;
        const deadline = Date.now() + w.timeout_s * 1000;
        const matcher = interpolate(waitMatcher(w), vars);
        let last = "";
        let satisfied = false;
        let polls = 0;
        while (!satisfied) {
          polls++;
          const rec = await driver.callTool(server, w.tool, interpolate(w.args ?? {}, vars));
          if (rec.error) last = `call failed: ${rec.error}`;
          else {
            const c = check(evalPath(rec, w.path), w.path, matcher);
            satisfied = c.ok;
            last = c.message;
          }
          if (satisfied) break;
          if (Date.now() + w.interval_s * 1000 > deadline || opts.signal?.aborted) break;
          await driver.sleep(w.interval_s * 1000);
        }
        if (satisfied) details.push(`satisfied after ${polls} poll(s)`);
        else fail(`timed out after ${w.timeout_s}s: ${last}`);
      } else if (step.device) {
        await driver.setDevice(step.device);
        details.push(`device -> ${step.device}`);
      } else if (step.call) {
        const rec = await driver.callTool(step.call.server ?? defaultServer, step.call.tool, interpolate(step.call.args ?? {}, vars));
        tools = [rec.tool];
        if (rec.error) fail(`call failed: ${rec.error}`);
        for (const [path, matcher] of entries(step.expect)) {
          const c = check(evalPath(rec, path), path, interpolate(matcher, vars));
          if (!c.ok) fail(c.message);
        }
        for (const [name, path] of Object.entries(step.save ?? {})) {
          const r = getPath(evalPath(rec, path), path);
          if (r.values.length) vars[name] = r.values[0];
          else fail(`save ${name}: path ${path} not found`);
        }
        if (ok) details.push(`called ${rec.tool}`);
      } else if (step.sleep_s !== undefined) {
        await driver.sleep(step.sleep_s * 1000);
      }
    } catch (err) {
      fail(`error: ${err instanceof Error ? err.message : String(err)}`);
    }

    const r: StepResult = { index: i + 1, label: stepLabel(step), status: ok ? "pass" : "fail", ms: Date.now() - started, details, spoken, tools };
    results.push(r);
    opts.onStep?.(r, step);
    if (!ok && opts.bail) break;
  }

  const failed = results.filter((r) => r.status === "fail").length;
  return { name: script.name, results, passed: results.length - failed, failed, ok: failed === 0 && results.length === script.steps.length, totalMs: Date.now() - t0 };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plain-text pass/fail table. */
export function formatReport(report: RunReport): string {
  const rows = report.results.map((r) => ({
    n: String(r.index),
    step: clip(r.label, 58),
    res: r.status === "pass" ? "PASS" : "FAIL",
    ms: `${r.ms}ms`,
    detail: r.details.join(" | "),
  }));
  const w = {
    n: Math.max(1, ...rows.map((r) => r.n.length)),
    step: Math.max(4, ...rows.map((r) => r.step.length)),
    res: 6,
    ms: Math.max(4, ...rows.map((r) => r.ms.length)),
  };
  const line = (n: string, step: string, res: string, ms: string, detail: string) => `${n.padStart(w.n)}  ${step.padEnd(w.step)}  ${res.padEnd(w.res)}  ${ms.padStart(w.ms)}  ${detail}`;
  const out = [line("#", "STEP", "RESULT", "TIME", "DETAIL"), line("-".repeat(w.n), "-".repeat(w.step), "-".repeat(w.res), "-".repeat(w.ms), "------")];
  for (const r of rows) out.push(line(r.n, r.step, r.res, r.ms, r.detail));
  out.push("", `${report.ok ? "PASS" : "FAIL"}: ${report.passed} passed, ${report.failed} failed in ${(report.totalMs / 1000).toFixed(1)}s`);
  return out.join("\n");
}
