import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dir = () => join(process.cwd(), "scripts");

/** List (and read) the YAML conversation scripts shipped in ./scripts for the "play script" mode. */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name");
  if (name) {
    if (!/^[\w.-]+\.ya?ml$/.test(name)) return Response.json({ error: "bad name" }, { status: 400 });
    try {
      return Response.json({ name, yaml: readFileSync(join(dir(), name), "utf8") });
    } catch {
      return Response.json({ error: "not found" }, { status: 404 });
    }
  }
  try {
    return Response.json({ scripts: readdirSync(dir()).filter((f) => /\.ya?ml$/.test(f)) });
  } catch {
    return Response.json({ scripts: [] });
  }
}
