import { getHub } from "@/lib/server/hub";
import type { ServerConfig } from "@/lib/mcp/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const hub = getHub();
  return Response.json({ connections: await hub.ensure() });
}

/** Replace the configured servers (from the settings drawer) and (re)connect. */
export async function POST(req: Request) {
  const body = (await req.json()) as { servers?: ServerConfig[] };
  if (!Array.isArray(body.servers)) return Response.json({ error: "servers[] required" }, { status: 400 });
  const servers = body.servers
    .filter((s) => s && typeof s.url === "string" && typeof s.id === "string")
    .map((s) => ({ ...s, auth: s.auth ?? { type: "none" as const } }));
  const connections = await getHub().configure(servers);
  return Response.json({ connections });
}
