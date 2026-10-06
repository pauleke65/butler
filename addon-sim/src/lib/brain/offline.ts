/**
 * Deterministic "Alexa brain" used when LLM_MODE=offline (tests, CI, rehearsals).
 *
 * It routes with keyword/regex scoring of the utterance against tool names, descriptions and input
 * schemas only - there is nothing add-on specific in here. Two light conventions are understood so
 * multi-turn flows work without a model:
 *   - a tool result with `structuredContent.needs_confirmation === true` makes a following "yes"
 *     re-issue the same call with `confirm: true` ("no" drops it);
 *   - a result with a single `pending_decisions[0].kind === "approve_action"` makes "yes"/"no" bind to
 *     an answer-style tool (a tool with a `choice` parameter).
 * `error.code === "AMBIGUOUS_REFERENCE"` with `candidates` produces a clarifying question and the
 * next utterance is matched against the candidates.
 */
import type { CallRecord, JsonSchema } from "../mcp/types";
import { spokenFromResult } from "../mcp/tools";
import type { Brain, BrainContext, BrainTool, BrainTurn, Conversation, RoutingDebug } from "./types";
import { contentStems, normalizeSpaces, ordinalIndex, stem, stripTrailingPunctuation, tokens } from "./text";

interface Lexeme {
  /** Matches the utterance. */
  when: RegExp;
  /** Must match the tool's name + description for the weight to apply. */
  tool: RegExp;
  weight: number;
}

/** Generic English intents for voice assistants -> words that tool names/descriptions use for them. */
const LEXICON: Lexeme[] = [
  // status / progress / "do you need anything from me"
  { when: /\b(how'?s|how is|how are|how'?re|looking|going|progress|status|what'?s left|where (are|do) (we|things)|update me|anything (you )?need|need(s)? (anything|something) from me|anything else)\b/i, tool: /status|progress|going|what'?s left|needs? anything|pending/i, weight: 6 },
  // explain / why
  { when: /\b(why|explain|reason|how come|what made you|what happened)\b/i, tool: /explain|why|reason|details? about/i, weight: 7 },
  // history questions: "what did you do/buy ..."
  { when: /^(what|which|show|list|tell me|give me|any)\b.*\b(did|done|do|bought|buy|purchased|happened|blocked|actions?|history)\b/i, tool: /list|what .* did|what it bought|actions?|history/i, weight: 6 },
  // corrections and standing preferences
  { when: /\b(don'?t|do not|never|stop|always|from now on|next time|without (asking|checking)|ask me (before|first)|check with me|i (don'?t|didn'?t|do not) (like|want)|i disagree|that was (wrong|too much)|too (much|expensive)|not okay)\b/i, tool: /disagrees|behave|from now on|propos\w* a rule|object/i, weight: 7 },
  // choosing / approving / declining
  { when: /\b(book|choose|pick|select|go with|i'?ll (take|have|go with)|let'?s (go with|do)|take the|approve|decline|reject|the (first|second|third|fourth|last)( one)?|option (\d|one|two|three))\b/i, tool: /choose|option|approve|decline|answer|decision|select/i, weight: 7 },
  // describing something coming up / a state of the home (intake)
  { when: /\b(coming (over|round|to)|visiting|staying|travel(l)?ing|going (away|to)|\baway\b|trip|running (low|out)|out of|guests?|hosting|having .* (over|round)|party|dinner|moving|expecting)\b/i, tool: /situation|describes|coming up|guests?|travel|running low|plan/i, weight: 6 },
  // rules
  { when: /\b(my rules|what rules|what am i allowed|what (are|is) .*(allowed|limits?)|which limits|set limits)\b/i, tool: /rules?|allowed|limits?/i, weight: 7 },
  { when: /\b(change|remove|delete|raise|lower|update|increase|decrease|drop)\b.*\b(rule|limit|cap)\b/i, tool: /change|remove|rule/i, weight: 8 },
  // undo
  { when: /\b(undo|reverse|take (it )?back|cancel (that|it|the)|refund)\b/i, tool: /undo|reverse|cancel|refund/i, weight: 8 },
];

const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|please do|confirm(ed)?|that'?s right|correct|make it a rule|approve)\b[\s.!,]*$/i;
const NO = /^(no|nope|nah|cancel|never ?mind|don'?t|not now|decline|reject)\b[\s.!,]*$/i;

const FREE_TEXT_PARAM = /^(situation|correction|request|query|text|message|utterance|input|change|prompt|description|question|note|command)$/i;

export interface RouteDecision {
  tool: BrainTool;
  score: number;
  candidates: Array<{ tool: string; score: number }>;
}

export interface Addressing {
  addressed: boolean;
  /** invocation name that was used, if any */
  serverId?: string;
  cleaned: string;
}

/** Detect "ask/tell/open <Invocation> (to|that|about) ..." and strip the frame. */
export function parseAddressing(utterance: string, servers: BrainContext["servers"]): Addressing {
  const text = normalizeSpaces(utterance);
  for (const s of servers) {
    const name = (s.invocationName ?? "").trim();
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const frame = new RegExp(`^(?:(?:hey|alexa)[,\\s]+)?(?:please\\s+)?(?:ask|tell|open|launch|start|talk to|have|let|say to|message)\\s+${esc}\\b[\\s,:]*(?:to|that|about|if|whether|how|what|why)?\\s*`, "i");
    const m = frame.exec(text);
    if (m) {
      let rest = text.slice(m[0].length);
      // keep question words we consumed ("ask Butler how Friday is looking")
      const lead = /(how|what|why|whether|if)\s*$/i.exec(m[0]);
      if (lead) rest = `${lead[1]} ${rest}`;
      return { addressed: true, serverId: s.id, cleaned: normalizeSpaces(rest) || text };
    }
    if (new RegExp(`\\b${esc}\\b`, "i").test(text)) {
      return { addressed: true, serverId: s.id, cleaned: normalizeSpaces(text.replace(new RegExp(`\\b${esc}\\b[,]?`, "i"), "")) };
    }
  }
  return { addressed: false, cleaned: text };
}

function enumValues(schema: JsonSchema | undefined): string[] {
  return (schema?.enum ?? []).filter((v): v is string => typeof v === "string");
}

function enumHits(tool: BrainTool, utterance: string): number {
  let hits = 0;
  const lower = utterance.toLowerCase();
  for (const prop of Object.values(tool.inputSchema.properties ?? {})) {
    for (const v of enumValues(prop)) {
      if (v === "all") continue;
      const phrase = v.replace(/[_-]+/g, " ").toLowerCase();
      if (phrase.length > 2 && new RegExp(`\\b${phrase}\\b`).test(lower)) hits++;
    }
  }
  return hits;
}

export function scoreTools(utterance: string, tools: BrainTool[], addressedServer?: string): RouteDecision | undefined {
  const uStems = new Set(contentStems(utterance));
  const scored = tools.map((tool) => {
    const nameStems = new Set(tool.name.split(/[_\W]+/).filter(Boolean).map(stem));
    const descStems = new Set(contentStems(tool.description));
    const haystack = `${tool.name.replace(/_/g, " ")} ${tool.description}`;
    let score = 0;
    for (const s of uStems) {
      if (nameStems.has(s)) score += 2;
      else if (descStems.has(s)) score += 1;
    }
    for (const lx of LEXICON) if (lx.when.test(utterance) && lx.tool.test(haystack)) score += lx.weight;
    score += 6 * enumHits(tool, utterance);
    if (addressedServer && tool.server === addressedServer) score += 1.5;
    return { tool, score };
  });
  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  const best = scored[0];
  if (!best) return undefined;
  return { tool: best.tool, score: best.score, candidates: scored.slice(0, 3).map((s) => ({ tool: s.tool.name, score: Math.round(s.score * 10) / 10 })) };
}

/** "Why did you buy the drinks?" -> "the drinks" */
export function extractReference(text: string): string {
  let t = stripTrailingPunctuation(text);
  t = t.replace(/^(?:so\s+)?(?:why|how come|explain|tell me (?:more )?about|what about|can you explain|could you explain|what was|what is|what'?s)\s+(?:did|do|was|were|is|are|you|the reason for|that)?\s*/i, "");
  t = t.replace(/^(?:you\s+)?(?:did\s+you\s+)?/i, "");
  t = t.replace(/^(?:buy|bought|buying|do|did|send|sent|book|booked|order|ordered|make|made|pick|picked|choose|chose|schedule|scheduled|add|added|spend|spent|purchase|purchased)\s+/i, "");
  return normalizeSpaces(t) || normalizeSpaces(text);
}

/** "Book BrightHome." -> "BrightHome"; "the second one" stays as is; "yes" -> "approve". */
export function extractChoice(text: string): string {
  const t = stripTrailingPunctuation(text);
  if (YES.test(t)) return "approve";
  if (NO.test(t)) return "reject";
  if (ordinalIndex(t) !== undefined && t.split(/\s+/).length <= 4) return t;
  const stripped = t
    .replace(/^(?:please\s+)?(?:let'?s\s+)?(?:i'?ll\s+)?(?:go with|take|book|choose|pick|select|have|do|want|i want|i'?d like|use)\s+/i, "")
    .replace(/^(?:the\s+)?/i, (m) => (/^the\s+(first|second|third|fourth|last)/i.test(t) ? m : ""))
    .replace(/\s+(?:please|for me|then)$/i, "");
  return normalizeSpaces(stripped) || t;
}

function findEnumMatch(prop: JsonSchema, utterance: string): string | undefined {
  const lower = utterance.toLowerCase();
  // longest phrase first so "might disagree" beats shorter overlaps
  const vals = enumValues(prop).sort((a, b) => b.length - a.length);
  for (const v of vals) {
    if (v === "all") continue;
    const phrase = v.replace(/[_-]+/g, " ").toLowerCase();
    if (new RegExp(`\\b${phrase}\\b`).test(lower)) return v;
  }
  // light synonyms for common period-ish enums
  const syn: Array<[RegExp, RegExp]> = [
    [/\b(this week|past week|last week|the week)\b/, /week/],
    [/\b(today|this morning|tonight)\b/, /^today$/],
    [/\b(bought|purchased|spent|buy)\b/, /purchase/],
    [/\b(blocked|held|denied|couldn'?t)\b/, /blocked/],
  ];
  for (const [u, e] of syn) if (u.test(lower)) for (const v of vals) if (e.test(v)) return v;
  return undefined;
}

/** Fill tool arguments from the utterance, using only the tool's JSON schema. */
export function buildArgs(tool: BrainTool, cleaned: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === "string" && enumValues(prop).length) {
      const v = findEnumMatch(prop, cleaned);
      if (v) args[name] = v;
      continue;
    }
    if (prop.type !== "string") continue;
    if (/_id$/i.test(name)) continue;
    if (/^reference$/i.test(name)) args[name] = extractReference(cleaned);
    else if (/^(choice|answer|option|selection)$/i.test(name)) args[name] = extractChoice(cleaned);
    else if (FREE_TEXT_PARAM.test(name) || required.has(name)) args[name] = cleaned;
  }
  return args;
}

function spokenForRecord(rec: CallRecord, serverName: string): string {
  if (rec.error) return `Sorry, I couldn't reach ${serverName} just now.`;
  const sc = rec.result?.structuredContent as { error?: { code?: string; candidates?: Array<{ label: string }> } } | undefined;
  if (sc?.error?.code === "AMBIGUOUS_REFERENCE" && !(sc.error as { message_spoken?: string }).message_spoken) {
    const labels = (sc.error.candidates ?? []).map((c) => c.label).slice(0, 3);
    return labels.length ? `Did you mean ${labels.join(" or ")}?` : "Which one did you mean?";
  }
  return spokenFromResult(rec.result);
}

function clarificationFrom(rec: CallRecord): Array<{ id: string; label: string }> | undefined {
  const sc = rec.result?.structuredContent as { error?: { code?: string; candidates?: Array<{ id: string; label: string }> } } | undefined;
  if (sc?.error?.code === "AMBIGUOUS_REFERENCE" && Array.isArray(sc.error.candidates) && sc.error.candidates.length) return sc.error.candidates;
  return undefined;
}

export class OfflineBrain implements Brain {
  readonly mode = "offline" as const;
  /** Below this score the router declines instead of guessing. */
  constructor(private readonly minScore = 3) {}

  async turn(conv: Conversation, utterance: string, ctx: BrainContext): Promise<BrainTurn> {
    const turn = await this.route(conv, utterance, ctx);
    conv.turns.push({ utterance, spoken: turn.spoken, calls: turn.calls });
    const last = turn.calls[turn.calls.length - 1];
    if (last) conv.lastCall = last;
    return turn;
  }

  private serverName(ctx: BrainContext, id: string): string {
    return ctx.servers.find((s) => s.id === id)?.name ?? id;
  }

  private async run(conv: Conversation, ctx: BrainContext, tool: BrainTool, args: Record<string, unknown>, routing: RoutingDebug): Promise<BrainTurn> {
    const rec = await ctx.callTool(tool.server, tool.name, args);
    const spoken = spokenForRecord(rec, this.serverName(ctx, tool.server));
    const candidates = clarificationFrom(rec);
    conv.pendingClarification = candidates ? { server: tool.server, tool: tool.name, args, candidates } : undefined;
    return { spoken, calls: [rec], routing: { ...routing, tool: tool.name, server: tool.server }, clarification: !!candidates };
  }

  private async route(conv: Conversation, utterance: string, ctx: BrainContext): Promise<BrainTurn> {
    const { addressed, serverId, cleaned } = parseAddressing(utterance, ctx.servers);
    const text = stripTrailingPunctuation(cleaned);

    // 1. Answer to our own clarifying question.
    const pc = conv.pendingClarification;
    if (pc) {
      const tool = ctx.tools.find((t) => t.server === pc.server && t.name === pc.tool);
      const pick = this.matchCandidate(text, pc.candidates);
      if (tool && pick) {
        const idParam = Object.keys(tool.inputSchema.properties ?? {}).find((p) => /_id$/.test(p) && p !== "plan_id");
        const args = { ...pc.args, ...(idParam ? { [idParam]: pick.id } : { reference: pick.label }) };
        return this.run(conv, ctx, tool, args, { reason: `clarification answered: ${pick.label}` });
      }
      conv.pendingClarification = undefined;
    }

    // 2. yes / no bound to the last pending confirmation.
    if (YES.test(text) || NO.test(text)) {
      const bound = await this.bindAffirmation(conv, ctx, YES.test(text));
      if (bound) return bound;
      return { spoken: YES.test(text) ? "Yes to what? I don't have anything waiting on you." : "Okay.", calls: [], routing: { reason: "no pending confirmation" } };
    }

    // 3. Score tools against the utterance.
    const modelTools = ctx.tools;
    if (!modelTools.length) return { spoken: "I don't have any add-ons connected right now.", calls: [], routing: { reason: "no tools" } };
    const decision = scoreTools(cleaned, modelTools, addressed ? serverId : undefined);
    if (!decision || decision.score < this.minScore) {
      // "Tell Butler <anything>" with no clear intent -> the add-on's free-text intake tool, if it has one.
      if (addressed && serverId) {
        const intake = modelTools.find((t) => t.server === serverId && Object.keys(t.inputSchema.properties ?? {}).some((p) => /^(situation|request|query|utterance|message|text)$/i.test(p)) && (t.inputSchema.required ?? []).length === 1);
        if (intake) return this.run(conv, ctx, intake, buildArgs(intake, cleaned), { reason: "addressed add-on, no strong intent -> intake tool", candidates: decision?.candidates });
      }
      return { spoken: "Sorry, I'm not sure which add-on can help with that.", calls: [], routing: { reason: "below threshold", score: decision?.score, candidates: decision?.candidates } };
    }
    const args = buildArgs(decision.tool, cleaned);
    return this.run(conv, ctx, decision.tool, args, { reason: "keyword/regex scoring", score: Math.round(decision.score * 10) / 10, candidates: decision.candidates });
  }

  private matchCandidate(text: string, cands: Array<{ id: string; label: string }>): { id: string; label: string } | undefined {
    const idx = ordinalIndex(text);
    if (idx !== undefined && text.split(/\s+/).length <= 4) return idx === -1 ? cands[cands.length - 1] : cands[idx];
    const u = new Set(contentStems(text));
    let best: { c: { id: string; label: string }; n: number } | undefined;
    for (const c of cands) {
      const n = contentStems(c.label).filter((s) => u.has(s)).length;
      if (n > 0 && (!best || n > best.n)) best = { c, n };
    }
    return best?.c;
  }

  private async bindAffirmation(conv: Conversation, ctx: BrainContext, yes: boolean): Promise<BrainTurn | undefined> {
    const last = conv.lastCall;
    const sc = last?.result?.structuredContent as { needs_confirmation?: boolean; pending_decisions?: Array<{ decision_id?: string; kind?: string }> } | undefined;
    if (!last || !sc) return undefined;
    const tool = ctx.tools.find((t) => t.server === last.server && t.name === last.tool);

    if (sc.needs_confirmation === true && tool) {
      if (!yes) return { spoken: "Okay, I won't change anything.", calls: [], routing: { reason: "declined pending confirmation", tool: tool.name, server: tool.server } };
      return this.run(conv, ctx, tool, { ...last.args, confirm: true }, { reason: "yes bound to pending confirmation" });
    }
    const dec = sc.pending_decisions?.length === 1 ? sc.pending_decisions[0] : undefined;
    if (dec?.kind === "approve_action") {
      const answer = ctx.tools.find((t) => t.server === last.server && "choice" in (t.inputSchema.properties ?? {}));
      if (answer) {
        const args: Record<string, unknown> = { choice: yes ? "approve" : "reject" };
        if (dec.decision_id && "decision_id" in (answer.inputSchema.properties ?? {})) args.decision_id = dec.decision_id;
        return this.run(conv, ctx, answer, args, { reason: `${yes ? "yes" : "no"} bound to pending approval` });
      }
    }
    return undefined;
  }
}

/** Exposed for tests. */
export const _internals = { tokens };
