// pnpm --filter ./server/ui preview:fixtures  ->  http://127.0.0.1:5180/
import { ensureServers } from "./servers.mjs";

const stop = await ensureServers();
console.log("\nButler views preview: http://127.0.0.1:5180/  (fixture MCP server on :8001). Ctrl+C to stop.\n");
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
await new Promise(() => {});
