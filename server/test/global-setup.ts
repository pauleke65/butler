/** Build the views once if they aren't built yet, so resource tests exercise the real single-file HTML. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const plan = resolve(root, "server/ui/dist/plan.html");
  if (existsSync(plan) || !existsSync(resolve(root, "server/ui/package.json"))) return;
  try {
    execFileSync("pnpm", ["--filter", "./server/ui", "build"], { cwd: root, stdio: "ignore", timeout: 120_000 });
  } catch {
    // Tests fall back to the placeholder page when the build is unavailable.
  }
}
