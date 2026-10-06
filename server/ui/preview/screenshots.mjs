// Renders every scenario at Echo Show 8 (1280x800) and Echo Show 15 (1920x1080) into docs/screenshots/ using a
// headless Chromium-family browser (Chrome, Edge, Chromium). Needs the fixture server (:8001) and preview server (:5180).
//   pnpm --filter ./server/ui screenshots [scenarioId ...]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureServers } from "./servers.mjs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../docs/screenshots");
mkdirSync(out, { recursive: true });

const candidates = [
  process.env.BROWSER_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const bin = candidates.find((p) => existsSync(p));
if (!bin) throw new Error("No Chromium-family browser found; set BROWSER_BIN");

const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5180";
const stop = await ensureServers();
const scenarios = [
  "plan-hosting", "plan-away", "options", "approval", "receipt-allowed", "receipt-booking", "receipt-held",
  "receipt-blocked", "receipt-failed", "actions", "actions-might", "ledger", "rule-draft", "rule-active", "rules", "error",
];
const only = process.argv.slice(2);
const devices = { show8: [1280, 800], show15: [1920, 1080] };

for (const s of only.length ? only : scenarios) {
  for (const [device, [w, h]] of Object.entries(devices)) {
    const file = resolve(out, `${s}.${device}.png`);
    const url = `${base}/frame.html?s=${s}&device=${device}&bare=1${s === "ledger" ? "&click=See%20more" : ""}`;
    execFileSync(
      bin,
      ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${w},${h}`,
        "--virtual-time-budget=8000", `--screenshot=${file}`, url],
      { stdio: "ignore", timeout: 60_000 },
    );
    console.log(`${s}.${device}.png`);
  }
}

stop();
