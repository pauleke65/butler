/** Error taxonomy (contracts §14). Handlers throw ButlerError; the central mapper turns anything into one. */
import type { ErrorCode } from "@butler/contracts";
import { ZodError } from "zod";

export interface Candidate {
  id: string;
  label: string;
}

export const SPOKEN_ERRORS: Record<ErrorCode, string> = {
  INVALID_INPUT: "I didn't catch the details. Could you say that again with the day and time?",
  NOT_FOUND: "I couldn't find that one.",
  AMBIGUOUS_REFERENCE: "I found more than one match. Which one did you mean?",
  NO_ACTIVE_PLAN: "You don't have anything in progress. Tell me what's coming up.",
  DUPLICATE_PLAN: "You already have a plan like that. Should I update it?",
  RULE_UNSUPPORTED:
    "I can make rules about spending limits, asking before a type of purchase, asking before booking services, asking before messaging new people, or never messaging a specific person.",
  POLICY_PROPAGATING: "Done. It'll take effect in a moment.",
  NOT_REVERSIBLE: "I can't undo that one.",
  BLOCKED_BY_NEVER_RULE: "Your rule says never to do that, so I didn't.",
  UPSTREAM_UNAVAILABLE: "The store isn't responding right now. I'll try again when you ask.",
  INTERNAL: "Something went wrong on my side. Please try again.",
};

export class ButlerError extends Error {
  readonly code: ErrorCode;
  readonly messageSpoken: string;
  readonly candidates: Candidate[] | undefined;
  readonly details: string | undefined;

  constructor(
    code: ErrorCode,
    messageSpoken?: string,
    opts: { candidates?: Candidate[]; details?: string; cause?: unknown } = {},
  ) {
    super(opts.details ?? messageSpoken ?? SPOKEN_ERRORS[code], opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ButlerError";
    this.code = code;
    this.messageSpoken = messageSpoken ?? SPOKEN_ERRORS[code];
    this.candidates = opts.candidates;
    this.details = opts.details;
  }
}

export function isButlerError(e: unknown): e is ButlerError {
  return e instanceof ButlerError;
}

export function formatZodIssues(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join(".") : "input"}: ${i.message}`)
    .join("; ");
}

export function invalidInput(details: string, spoken?: string): ButlerError {
  return new ButlerError("INVALID_INPUT", spoken, { details });
}

export function notFound(spoken?: string, details?: string): ButlerError {
  return new ButlerError("NOT_FOUND", spoken, details === undefined ? {} : { details });
}

function looksLikeTimeout(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === "AbortError" || e.name === "TimeoutError" || /timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed/i.test(e.message);
}

/** Map any thrown value to a ButlerError (never throws). */
export function mapError(e: unknown): ButlerError {
  if (isButlerError(e)) return e;
  if (e instanceof ZodError) return invalidInput(formatZodIssues(e));
  if (looksLikeTimeout(e)) return new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { cause: e, details: (e as Error).message });
  const message = e instanceof Error ? e.message : String(e);
  return new ButlerError("INTERNAL", undefined, { cause: e, details: message });
}

/** Race a promise against a timeout; rejects with UPSTREAM_UNAVAILABLE. */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: `${what} timed out after ${ms} ms` })),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
