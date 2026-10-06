#!/usr/bin/env tsx
/**
 * Headless conversation runner:  pnpm play scripts/butler-golden.yaml
 *
 *   --url <mcp url>      override the target server URL (default: SIM_SERVERS / http://localhost:8000/mcp)
 *   --token <bearer>     bearer token for that server
 *   --server <id>        server id the script targets (default: script `server:` or the first configured server)
 *   --llm offline|bedrock   brain implementation (default: LLM_MODE or offline)
 *   --bail               stop at the first failing step
 *   --json               print the report as JSON
 */
import { readFileSync } from "node:fs";
import { createBrain } from "../lib/brain/factory";
import { defaultServers } from "../lib/config";
import { McpClientManager } from "../lib/mcp/client-manager";
import type { ServerConfig } from "../lib/mcp/types";
import { LocalDriver, autoElicit } from "../lib/runner/local-driver";
import { formatReport, runScript } from "../lib/runner/runner";
import { ScriptError, parseScript } from "../lib/runner/script";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (["bail", "json", "help", "verbose"].includes(key)) flags[key] = true;
      else {
        flags[key] = next ?? "";
        i++;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

async function main(): Promise<number> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help || !positional[0]) {
    console.log("usage: run-script <script.yaml> [--url URL] [--token T] [--server ID] [--llm offline|bedrock] [--bail] [--json]");
    return flags.help ? 0 : 2;
  }
  let script;
  try {
    script = parseScript(readFileSync(positional[0], "utf8"));
  } catch (err) {
    console.error(err instanceof ScriptError ? err.message : String(err));
    return 2;
  }

  const env = { ...process.env } as Record<string, string | undefined>;
  if (typeof flags.llm === "string") env.LLM_MODE = flags.llm;
  const servers: ServerConfig[] = defaultServers(env);
  const targetId = (typeof flags.server === "string" && flags.server) || script.server || servers[0]!.id;
  let target = servers.find((s) => s.id === targetId);
  if (!target) {
    target = { id: targetId, name: targetId, url: "http://localhost:8000/mcp", auth: { type: "none" }, enabled: true };
    servers.push(target);
  }
  if (typeof flags.url === "string") target.url = flags.url;
  if (typeof flags.token === "string") target.auth = { type: "bearer", token: flags.token };

  const manager = new McpClientManager();
  manager.defaultElicit = autoElicit(script.elicitation);
  const infos = await manager.configure(servers);
  const bad = infos.filter((i) => i.status === "error");
  for (const b of bad) console.error(`! could not connect to ${b.id} (${b.url}): ${b.error}`);
  const conn = infos.find((i) => i.id === targetId);
  if (!conn || conn.status !== "connected") {
    console.error(`target server "${targetId}" is not reachable`);
    await manager.close();
    return 2;
  }
  if (!flags.json) {
    console.log(`server  ${conn.id}  ${conn.url}  (${conn.serverInfo?.name} ${conn.serverInfo?.version}, protocol ${conn.protocolVersion}, ${conn.tools.length} tools)`);
    console.log(`brain   ${createBrain(env).mode}${script.device ? `   device ${script.device}` : ""}\n`);
  }

  const brain = createBrain(env);
  const driver = new LocalDriver(manager, brain, targetId, Object.fromEntries(servers.map((s) => [s.id, s.invocationName])));
  const report = await runScript(script, driver, { bail: !!flags.bail });
  await manager.close();

  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(formatReport(report));
    for (const r of report.results.filter((x) => x.status === "fail")) {
      console.log(`\nstep ${r.index} failed: ${r.label}`);
      for (const d of r.details) console.log(`  - ${d}`);
    }
  }
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
