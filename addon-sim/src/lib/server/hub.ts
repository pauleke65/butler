import { BedrockBrain } from "../brain/bedrock";
import { createBrain, resolveLlmMode } from "../brain/factory";
import type { Brain } from "../brain/types";
import { defaultServers } from "../config";
import { McpClientManager } from "../mcp/client-manager";
import type { ConnectionInfo, ElicitationRequestInfo, ElicitationResponse, ServerConfig } from "../mcp/types";
import type { HubEvent } from "../events";

/** Process-wide singletons for the Next.js server (survive dev HMR via globalThis). */
export class Hub {
  readonly manager = new McpClientManager();
  readonly brain: Brain = createBrain();
  readonly llmMode = resolveLlmMode();
  servers: ServerConfig[] = defaultServers();
  private configuring?: Promise<ConnectionInfo[]>;
  private pending = new Map<string, (r: ElicitationResponse) => void>();
  private subscribers = new Set<(e: HubEvent) => void>();

  constructor() {
    this.manager.defaultElicit = (req) => this.askElicitation(req);
  }

  private brains = new Map<string, Brain>();

  /** The brain for a turn. In bedrock mode a model override from the settings drawer gets its own (cached) brain. */
  brainFor(model?: string): Brain {
    const def = process.env.BEDROCK_MODEL_BRAIN || "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    if (this.llmMode !== "bedrock" || !model || model === def) return this.brain;
    let b = this.brains.get(model);
    if (!b) {
      b = new BedrockBrain({ model, region: process.env.AWS_REGION || "us-east-1" });
      this.brains.set(model, b);
    }
    return b;
  }

  /** Connect the configured servers on first use. */
  ensure(): Promise<ConnectionInfo[]> {
    this.configuring ??= this.manager.configure(this.servers);
    return this.configuring;
  }

  async configure(servers: ServerConfig[]): Promise<ConnectionInfo[]> {
    this.servers = servers;
    this.configuring = this.manager.configure(servers);
    return this.configuring;
  }

  subscribe(fn: (e: HubEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(e: HubEvent): void {
    for (const s of this.subscribers) s(e);
  }

  /** Ask the browser (via the events stream) to answer an elicitation. Declines after 2 minutes or with no UI attached. */
  private askElicitation(req: ElicitationRequestInfo): Promise<ElicitationResponse> {
    if (this.subscribers.size === 0) return Promise.resolve({ action: "decline" });
    return new Promise<ElicitationResponse>((resolve) => {
      const timer = setTimeout(() => this.answerElicitation(req.id, { action: "cancel" }), 120_000);
      this.pending.set(req.id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.emit({ type: "elicitation", request: req });
    });
  }

  answerElicitation(id: string, res: ElicitationResponse): boolean {
    const fn = this.pending.get(id);
    if (!fn) return false;
    this.pending.delete(id);
    fn(res);
    this.emit({ type: "elicitation_done", id });
    return true;
  }
}

const g = globalThis as unknown as { __addonSimHub?: Hub };
export function getHub(): Hub {
  return (g.__addonSimHub ??= new Hub());
}
