/** Everything injectable (05-local-build.md §6). Tools only ever touch the outside world through `Deps`. */
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import {
  AgentClientImpl,
  AgentCoreTransport,
  LocalAgentTransport,
  UnconfiguredAgentTransport,
  type AgentClient,
  type AgentTransport,
} from "./lib/agentClient.js";
import { BedrockNeedsPass } from "./lib/bedrockNeedsPass.js";
import {
  ExecutorClientImpl,
  LambdaExecutorTransport,
  LocalExecutorTransport,
  UnconfiguredExecutorTransport,
  type ExecutorClient,
  type ExecutorTransport,
} from "./lib/executorClient.js";
import { makeIdGenerator, type NewId } from "./lib/ids.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { KeywordNeedsPass, type NeedsPass } from "./lib/needsPass.js";
import { createDynamoRepo, type Repo } from "./lib/repo.js";

export interface Deps {
  repo: Repo;
  agent: AgentClient;
  executor: ExecutorClient;
  needsPass: NeedsPass;
  now(): Date;
  newId: NewId;
  config: Config;
  logger: Logger;
  /** Run work after the response (fire-and-forget) with error logging; never throws. */
  background(label: string, work: () => Promise<unknown>): void;
}

/** Background runner that tracks in-flight work so tests can `await settle()`. */
export function createBackground(logger: Logger): { run: Deps["background"]; settle(): Promise<void> } {
  const pending = new Set<Promise<void>>();
  return {
    run(label, work) {
      const p = Promise.resolve()
        .then(work)
        .then(
          () => undefined,
          (e: unknown) => logger.log("error", "background.failed", { label, error: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => pending.delete(p));
      pending.add(p);
    },
    async settle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

export function makeClock(config: Config): () => Date {
  if (config.nowOverride) {
    const pinned = new Date(config.nowOverride);
    if (!Number.isNaN(pinned.getTime())) return () => new Date(pinned.getTime());
  }
  return () => new Date();
}

/** The one place that branches on configuration to pick implementations. */
export function buildDeps(config: Config = loadConfig(), logger: Logger = createLogger({ level: config.logLevel })): Deps {
  const now = makeClock(config);
  const newId = makeIdGenerator(() => now().getTime());

  const repo = createDynamoRepo({
    tableName: config.tableName,
    region: config.region,
    ...(config.dynamodbEndpoint ? { endpoint: config.dynamodbEndpoint } : {}),
  });

  const agentTransport: AgentTransport = config.agentLocalUrl
    ? new LocalAgentTransport(config.agentLocalUrl)
    : config.agentRuntimeArn
      ? new AgentCoreTransport(config.agentRuntimeArn)
      : new UnconfiguredAgentTransport();

  const executorTransport: ExecutorTransport = config.executorLocalUrl
    ? new LocalExecutorTransport(config.executorLocalUrl)
    : config.executorFunctionName
      ? new LambdaExecutorTransport(config.executorFunctionName)
      : new UnconfiguredExecutorTransport();

  const keywords = new KeywordNeedsPass();
  const needsPass: NeedsPass =
    config.llmMode === "bedrock"
      ? new BedrockNeedsPass({
          modelId: config.bedrockModelFast,
          region: config.region,
          timeoutMs: config.needsPassTimeoutMs,
          fallback: keywords,
          logger,
        })
      : keywords;

  return {
    repo,
    agent: new AgentClientImpl(agentTransport),
    executor: new ExecutorClientImpl(executorTransport, config.executorTimeoutMs),
    needsPass,
    now,
    newId,
    config,
    logger,
    background: createBackground(logger).run,
  };
}
