/** Bearer token handling and household resolution (contracts §1: household comes from the token, never from input). */
import { LOCAL_SIM_TOKEN, type Config } from "../config.js";

export interface Principal {
  /** The token's `sub` (or a static id for local tokens). */
  sub: string;
  householdId: string;
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; status: 401; reason: string };

function decodeJwtSub(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      // client-credentials tokens carry client_id rather than a user sub
      const sub = typeof p["sub"] === "string" ? p["sub"] : typeof p["client_id"] === "string" ? p["client_id"] : undefined;
      return sub;
    }
  } catch {
    /* not a JWT */
  }
  return undefined;
}

export function householdFor(sub: string, map: Record<string, string>): string | undefined {
  return map[sub] ?? map["*"];
}

/**
 * STAGE=local: no auth, or `local-sim-token`. Otherwise a bearer token is required. On AgentCore Runtime the JWT
 * authorizer has already verified the signature, so here we only read `sub`/`client_id` to pick the household.
 */
export function authenticate(authorization: string | undefined, config: Config): AuthResult {
  const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
  const token = match?.[1]?.trim();

  if (!token) {
    if (config.stage === "local") {
      const hh = householdFor("local-anonymous", config.householdBySub);
      return hh ? { ok: true, principal: { sub: "local-anonymous", householdId: hh } } : { ok: false, status: 401, reason: "no household for caller" };
    }
    return { ok: false, status: 401, reason: "missing bearer token" };
  }

  if (token === LOCAL_SIM_TOKEN) {
    const hh = householdFor("local-sim", config.householdBySub);
    return hh ? { ok: true, principal: { sub: "local-sim", householdId: hh } } : { ok: false, status: 401, reason: "no household for caller" };
  }

  const sub = decodeJwtSub(token);
  if (!sub) return { ok: false, status: 401, reason: "unrecognised bearer token" };
  const hh = householdFor(sub, config.householdBySub);
  return hh ? { ok: true, principal: { sub, householdId: hh } } : { ok: false, status: 401, reason: "no household for caller" };
}
