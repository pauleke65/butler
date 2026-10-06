/** Process entry: `pnpm --filter ./server dev` -> http://localhost:8000/mcp */
import { buildDeps } from "./deps.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { createLogger } from "./lib/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const deps = buildDeps(config, logger);
  const server = createHttpApp(deps);
  server.listen(config.port, "0.0.0.0", () => {
    logger.log("info", "butler.server.listening", {
      port: config.port,
      path: "/mcp",
      stage: config.stage,
      llm_mode: config.llmMode,
      agent: config.agentLocalUrl ?? config.agentRuntimeArn ?? "unconfigured",
      executor: config.executorLocalUrl ?? config.executorFunctionName ?? "unconfigured",
      table: config.tableName,
      dynamodb_endpoint: config.dynamodbEndpoint ?? "aws",
    });
  });
  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
