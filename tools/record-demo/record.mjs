/**
 * Records the golden demo: drives the simulator in a real (headless) Edge/Chrome, captures frames with the
 * DevTools screencast, adds on-screen captions, and encodes an mp4 with ffmpeg.
 *
 *   scripts/stack.sh start && (cd addon-sim && PANEL_URLS=... pnpm dev)   # see README
 *   node record.mjs [--out ../../docs/demo/butler-demo.mp4] [--base http://localhost:3000]
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const BASE = arg("base", "http://localhost:3000");
const OUT = resolve(here, arg("out", "../../docs/demo/butler-demo.mp4"));
const FRAMES = resolve(here, ".frames");
const W = 1600, H = 900;
const EDGE = process.env.BROWSER_PATH ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

// ── screencast capture ────────────────────────────────────────────────────────
const cdp = await ctx.newCDPSession(page);
const frames = []; // {file, t}
let n = 0;
cdp.on("Page.screencastFrame", async (f) => {
  const file = `${FRAMES}/f${String(n++).padStart(6, "0")}.jpg`;
  writeFileSync(file, Buffer.from(f.data, "base64"));
  frames.push({ file, t: f.metadata.timestamp });
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
const startCapture = () => cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1, maxWidth: W, maxHeight: H });

// ── helpers ───────────────────────────────────────────────────────────────────
async function overlay(title, sub, { full = false } = {}) {
  await page.evaluate(({ title, sub, full }) => {
    let el = document.getElementById("__cap");
    if (!el) { el = document.createElement("div"); el.id = "__cap"; document.body.appendChild(el); }
    el.style.cssText = full
      ? "position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#0b1220;color:#e8eefc;font:600 44px/1.2 -apple-system,Segoe UI,sans-serif;text-align:center;padding:0 140px;"
      : "position:fixed;left:50%;transform:translateX(-50%);top:14px;z-index:99999;max-width:1200px;background:rgba(10,16,32,.92);border:1px solid #3a4a73;border-radius:14px;color:#fff;font:600 22px/1.3 -apple-system,Segoe UI,sans-serif;padding:12px 22px;text-align:center;box-shadow:0 6px 30px rgba(0,0,0,.45);";
    el.innerHTML = `<div>${title}</div>${sub ? `<div style="font:400 ${full ? 26 : 17}px/1.35 -apple-system,Segoe UI,sans-serif;color:#9fb2dd;margin-top:6px">${sub}</div>` : ""}`;
  }, { title, sub, full });
}
const clearOverlay = () => page.evaluate(() => document.getElementById("__cap")?.remove());

const input = () => page.getByPlaceholder("…or type what you would say");
async function say(text, { settle = 3500 } = {}) {
  await input().click();
  await page.keyboard.type(text, { delay: 38 });
  await sleep(500);
  await page.keyboard.press("Enter");
  await sleep(settle);
}
async function waitForCall(toolName, timeout = 20000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), toolName, { timeout }).catch(() => {});
}

// ── run ───────────────────────────────────────────────────────────────────────
await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.reload({ waitUntil: "networkidle" });
await sleep(1500);
await page.getByRole("button", { name: "Smart display 15" }).click();
await sleep(800);

await startCapture();
await overlay("Butler", "An Alexa+ add-on that acts for you, shows a receipt for every action,<br/>and turns your corrections into rules the AI cannot break.", { full: true });
await sleep(5500);
await clearOverlay();

await overlay("1 · Describe a situation", "Not a command. Butler works out what it needs.");
await say("Tell Butler six friends from the dinner crew are coming over Friday at 7.", { settle: 4500 });

await overlay("2 · It handles what it can, and asks about the rest", "Invites sent, calendar set, drinks bought. Cleaning needs your call.");
await sleep(2500);
await say("How's Friday looking?", { settle: 4500 });

await overlay("3 · Tap a screen, or just say it", "Choosing a cleaner runs through the approval path, not the AI.");
// try the on-screen Choose button inside the nested iframes, else fall back to voice
let clicked = false;
for (const f of page.frames()) {
  const btn = f.getByRole("button", { name: "Choose" }).first();
  if (await btn.count().catch(() => 0)) { await btn.click({ timeout: 3000 }).catch(() => {}); clicked = true; break; }
}
if (!clicked) await say("Book BrightHome.");
await sleep(4500);

await overlay("4 · Every action has a receipt", "What it did, why, what it rejected, and which rule allowed it.");
await say("Why did you buy the drinks?", { settle: 5000 });

await overlay("5 · Object once, and it becomes a rule", "The AI drafts it; deterministic code compiles it to policy.");
await say("Don't buy drinks without asking me.", { settle: 4000 });
await say("Yes.", { settle: 5500 });

await overlay("6 · Next time, the rule blocks it. Watch the panel.", "The gateway denies the purchase before anything is bought.");
await say("I'm travelling Thursday to Sunday. My parents are staying at the house.", { settle: 6500 });
await overlay("The DENY is enforced outside the AI", "Butler stops and asks you instead of buying.");
await sleep(3500);
await say("Anything you need from me?", { settle: 6000 });

await overlay("7 · See what it did that you might disagree with", "");
await say("What did you do this week that I might disagree with?", { settle: 6000 });

await overlay("Alexa can act for you without being a black box.", "Every action has a receipt. Every correction becomes a rule.", { full: true });
await sleep(5000);

await cdp.send("Page.stopScreencast").catch(() => {});
await browser.close();

// ── encode ────────────────────────────────────────────────────────────────────
if (frames.length < 10) { console.error("too few frames captured:", frames.length); process.exit(1); }
const list = [];
for (let i = 0; i < frames.length; i++) {
  const next = frames[i + 1]?.t ?? frames[i].t + 1.5;
  list.push(`file '${frames[i].file}'`, `duration ${Math.max(0.02, Math.min(next - frames[i].t, 8)).toFixed(3)}`);
}
list.push(`file '${frames.at(-1).file}'`);
writeFileSync(`${FRAMES}/list.txt`, list.join("\n"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${FRAMES}/list.txt`,
  "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", OUT], { stdio: "inherit" });
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT]).toString().trim();
console.log(`wrote ${OUT}  (${frames.length} frames, ${Number(dur).toFixed(1)} s)`);
rmSync(FRAMES, { recursive: true, force: true });
