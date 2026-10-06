import { parse } from "yaml";
import { z } from "zod";

const matcher = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({
    equals: z.unknown().optional(),
    contains: z.unknown().optional(),
    matches: z.string().optional(),
    exists: z.boolean().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    one_of: z.array(z.unknown()).optional(),
    includes_all: z.array(z.unknown()).optional(),
    any_equal: z.unknown().optional(),
    none_equal: z.unknown().optional(),
    all_equal: z.unknown().optional(),
    length: z.number().optional(),
  }),
]);

export type Matcher = z.infer<typeof matcher>;

const waitUntil = z
  .object({
    tool: z.string(),
    server: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    path: z.string(),
    timeout_s: z.number().positive().default(60),
    interval_s: z.number().positive().default(1),
    equals: z.unknown().optional(),
    contains: z.unknown().optional(),
    matches: z.string().optional(),
    exists: z.boolean().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    one_of: z.array(z.unknown()).optional(),
    includes_all: z.array(z.unknown()).optional(),
    any_equal: z.unknown().optional(),
    none_equal: z.unknown().optional(),
    all_equal: z.unknown().optional(),
    length: z.number().optional(),
  })
  .strict();

export type WaitUntil = z.infer<typeof waitUntil>;

const step = z
  .object({
    name: z.string().optional(),
    say: z.string().optional(),
    expect_tool: z.union([z.string(), z.array(z.string())]).optional(),
    /** path -> matcher; a list of such maps lets one path be asserted several times. */
    expect: z.union([z.record(z.string(), matcher), z.array(z.record(z.string(), matcher))]).optional(),
    expect_args: z.union([z.record(z.string(), matcher), z.array(z.record(z.string(), matcher))]).optional(),
    expect_spoken: z.union([z.string(), z.array(z.string())]).optional(),
    expect_spoken_contains: z.union([z.string(), z.array(z.string())]).optional(),
    save: z.record(z.string(), z.string()).optional(),
    wait_until: waitUntil.optional(),
    device: z.string().optional(),
    /** Call a tool directly (no brain), e.g. to reset or inspect state. */
    call: z.object({ tool: z.string(), server: z.string().optional(), args: z.record(z.string(), z.unknown()).optional() }).optional(),
    /** Pause, in seconds. */
    sleep_s: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((s) => [s.say, s.wait_until, s.device, s.call, s.sleep_s].filter((v) => v !== undefined).length === 1, {
    message: "each step needs exactly one of: say, wait_until, device, call, sleep_s",
  });

export type Step = z.infer<typeof step>;

const script = z
  .object({
    name: z.string().optional(),
    server: z.string().optional(),
    device: z.string().optional(),
    elicitation: z.enum(["accept-defaults", "decline"]).default("accept-defaults"),
    steps: z.array(step).min(1),
  })
  .strict();

export type Script = z.infer<typeof script>;

export class ScriptError extends Error {}

export function parseScript(yamlText: string): Script {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    throw new ScriptError(`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = script.safeParse(raw);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ScriptError(`Invalid script: ${msg}`);
  }
  return res.data;
}
