/**
 * Approval executor client (contracts §6). Local: HTTP POST to EXECUTOR_LOCAL_URL (`butler_executor.server`);
 * AWS: Lambda Invoke of `butler-approval-executor`. Both are synchronous with a hard timeout.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Decision as DecisionSchema, Receipt as ReceiptSchema, ERROR_CODES, type Decision, type ErrorCode, type ExecutorRequest, type Receipt } from "@butler/contracts";
import { z } from "zod";
import { ButlerError, SPOKEN_ERRORS } from "./errors.js";

export const ExecutorEnvelope = z.object({
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).optional(),
});
export type ExecutorEnvelope = z.infer<typeof ExecutorEnvelope>;

export interface ExecutorTransport {
  invoke(req: ExecutorRequest, timeoutMs: number): Promise<ExecutorEnvelope>;
}

export class LocalExecutorTransport implements ExecutorTransport {
  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async invoke(req: ExecutorRequest, timeoutMs: number): Promise<ExecutorEnvelope> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { cause: e, details: `executor unreachable: ${(e as Error).message}` });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: `executor returned non-JSON (HTTP ${res.status})` });
    }
    const parsed = ExecutorEnvelope.safeParse(json);
    if (!parsed.success) throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: `executor returned an unexpected body (HTTP ${res.status})` });
    return parsed.data;
  }
}

export class LambdaExecutorTransport implements ExecutorTransport {
  constructor(
    private readonly functionName: string,
    private readonly client: Pick<LambdaClient, "send"> = new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
  ) {}

  async invoke(req: ExecutorRequest, timeoutMs: number): Promise<ExecutorEnvelope> {
    try {
      const res = await this.client.send(
        new InvokeCommand({ FunctionName: this.functionName, Payload: new TextEncoder().encode(JSON.stringify(req)) }),
        { abortSignal: AbortSignal.timeout(timeoutMs) },
      );
      if (res.FunctionError) throw new Error(`lambda error: ${res.FunctionError}`);
      const body = res.Payload ? new TextDecoder().decode(res.Payload) : "";
      return ExecutorEnvelope.parse(JSON.parse(body));
    } catch (e) {
      if (e instanceof ButlerError) throw e;
      throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { cause: e, details: `executor invoke failed: ${(e as Error).message}` });
    }
  }
}

export class UnconfiguredExecutorTransport implements ExecutorTransport {
  async invoke(): Promise<ExecutorEnvelope> {
    throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: "executor is not configured (set EXECUTOR_LOCAL_URL or EXECUTOR_FUNCTION_NAME)" });
  }
}

// ───────────────────────────── typed client ─────────────────────────────

export interface ExecutorCtx {
  householdId: string;
  correlationId: string;
}

export interface UndoResult {
  undo: Receipt;
  original: Receipt | undefined;
}

export interface ExecutorClient {
  runDecision(ctx: ExecutorCtx, decisionId: string, optionId: string): Promise<{ decision: Decision; receipt: Receipt }>;
  undo(ctx: ExecutorCtx, actionId: string): Promise<UndoResult>;
}

export const EXECUTOR_TIMEOUT_MS = 8_000;

function isErrorCode(c: string): c is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(c);
}

export function executorError(env: ExecutorEnvelope): ButlerError {
  const code = env.error?.code ?? "INTERNAL";
  if (isErrorCode(code)) return new ButlerError(code, SPOKEN_ERRORS[code], env.error?.message === undefined ? {} : { details: env.error.message });
  // Unknown executor codes (provider failures etc.) are upstream problems from the customer's point of view.
  return new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: `executor error ${code}${env.error?.message ? `: ${env.error.message}` : ""}` });
}

export class ExecutorClientImpl implements ExecutorClient {
  constructor(
    private readonly transport: ExecutorTransport,
    private readonly timeoutMs: number = EXECUTOR_TIMEOUT_MS,
  ) {}

  async runDecision(ctx: ExecutorCtx, decisionId: string, optionId: string) {
    const env = await this.transport.invoke(
      { mode: "decision", household_id: ctx.householdId, correlation_id: ctx.correlationId, decision_id: decisionId, option_id: optionId },
      this.timeoutMs,
    );
    if (!env.ok) throw executorError(env);
    const decision = DecisionSchema.safeParse(env.data?.["decision"]);
    const receipt = ReceiptSchema.safeParse(env.data?.["receipt"]);
    if (!decision.success || !receipt.success) {
      throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: "executor returned an invalid decision/receipt" });
    }
    return { decision: decision.data, receipt: receipt.data };
  }

  async undo(ctx: ExecutorCtx, actionId: string): Promise<UndoResult> {
    const env = await this.transport.invoke(
      { mode: "undo", household_id: ctx.householdId, correlation_id: ctx.correlationId, action_id: actionId },
      this.timeoutMs,
    );
    if (!env.ok) throw executorError(env);
    // Contract §6 doesn't pin the undo response; accept `{undo, original}` or `{receipt}`.
    const undo = ReceiptSchema.safeParse(env.data?.["undo"] ?? env.data?.["receipt"]);
    if (!undo.success) throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: "executor returned no undo receipt" });
    const original = ReceiptSchema.safeParse(env.data?.["original"]);
    return { undo: undo.data, original: original.success ? original.data : undefined };
  }
}
