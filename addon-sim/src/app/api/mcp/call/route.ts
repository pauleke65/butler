import { getHub } from "@/lib/server/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** tools/call forwarded on behalf of a view (MCP App) or a panel. */
export async function POST(req: Request) {
  const body = (await req.json()) as { server?: string; tool?: string; args?: Record<string, unknown>; origin?: "view" | "panel" | "script" };
  if (!body.server || !body.tool) return Response.json({ error: "server and tool required" }, { status: 400 });
  const hub = getHub();
  await hub.ensure();
  const rec = await hub.manager.callTool(body.server, body.tool, body.args ?? {}, { origin: body.origin ?? "view" });
  return Response.json(rec);
}
