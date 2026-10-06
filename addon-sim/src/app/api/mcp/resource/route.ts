import { getHub } from "@/lib/server/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fetch (and cache for the session) a ui:// resource. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const server = url.searchParams.get("server");
  const uri = url.searchParams.get("uri");
  if (!server || !uri) return Response.json({ error: "server and uri required" }, { status: 400 });
  if (url.searchParams.get("refresh") === "1") getHub().manager.clearResourceCache();
  try {
    return Response.json(await getHub().manager.readUiResource(server, uri));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
