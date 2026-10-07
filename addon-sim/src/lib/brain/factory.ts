import type { Brain } from "./types";
import { OfflineBrain } from "./offline";
import { BedrockBrain } from "./bedrock";

export type LlmMode = "offline" | "bedrock";

export function resolveLlmMode(env: Record<string, string | undefined> = process.env): LlmMode {
  return env.LLM_MODE === "bedrock" ? "bedrock" : "offline";
}

/** The only place that branches on LLM_MODE. Both brains implement the same `Brain` interface. */
export function createBrain(env: Record<string, string | undefined> = process.env): Brain {
  if (resolveLlmMode(env) === "bedrock") {
    return new BedrockBrain({
      model: env.BEDROCK_MODEL_BRAIN || "us.amazon.nova-2-lite-v1:0",
      region: env.AWS_REGION || "us-east-1",
    });
  }
  return new OfflineBrain();
}
