/**
 * Records the golden demo: drives the simulator in a real (headless) Edge/Chrome, captures frames with the
 * DevTools screencast, adds on-screen captions, and encodes an mp4 with ffmpeg.
 *
 * With narration (default) the customer's lines and Butler's replies are spoken with local macOS voices
 * (`say`, no cloud calls) and mixed in at the moments they happen on screen.
 *
 *   node record.mjs [--out ../../docs/demo/butler-demo.mp4] [--base http://localhost:3000] [--silent]
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const BASE = arg("base", "http://localhost:3000");
const OUT = resolve(here, arg("out", "../../docs/demo/butler-demo.mp4"));
const NARRATE = !process.argv.includes("--silent");
const WORK = resolve(here, ".frames");
const W = 1600, H = 900;
const EDGE = process.env.BROWSER_PATH ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
// TTS=polly uses Amazon Polly (generative / long-form voices; needs AWS credentials, a few cents per take);
// TTS=say (default) uses free local macOS voices.
const TTS = process.env.TTS ?? "say";
const VOICES = TTS === "polly"
  ? { you: process.env.VOICE_YOU ?? "Matthew", butler: process.env.VOICE_BUTLER ?? "Ruth", narrator: process.env.VOICE_NARRATOR ?? "Gregory" }
  : { you: process.env.VOICE_YOU ?? "Reed (English (US))", butler: process.env.VOICE_BUTLER ?? "Samantha", narrator: process.env.VOICE_NARRATOR ?? "Daniel" };
const POLLY_ENGINE = { [VOICES.you]: "generative", [VOICES.butler]: "generative", [VOICES.narrator]: "long-form" };
const TEMPO = Number(process.env.TTS_TEMPO ?? (TTS === "polly" ? "1.12" : "1")); // Polly speaks slowly; keep the take under 3:00

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/audio`, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

// ── speech (local macOS voices) ────────────────────────────────────────────────
let clipN = 0;
const clips = []; // {file, wall}
const RATE = { [VOICES.you]: "225", [VOICES.butler]: "215", [VOICES.narrator]: "205" };
function synth(voice, text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = `${WORK}/audio/c${String(clipN++).padStart(3, "0")}`;
    const file = `${base}.wav`;
    try {
      const raw = TTS === "polly" ? `${base}.mp3` : `${base}.aiff`;
      if (TTS === "polly") {
        execFileSync("aws", ["polly", "synthesize-speech", "--engine", POLLY_ENGINE[voice] ?? "generative", "--voice-id", voice,
          "--output-format", "mp3", "--text", text, raw], { stdio: "pipe" });
      } else {
        execFileSync("say", ["-v", voice, "-r", RATE[voice] ?? "200", "-o", raw, "--", text], { stdio: "pipe" });
      }
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-af", `atempo=${TEMPO}`, "-ar", "44100", file]);
      const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
      return { file, dur };
    } catch (e) {
      console.warn(`say failed (attempt ${attempt + 1}) for "${text.slice(0, 40)}": ${String(e.stderr ?? e.message).trim()}`);
    }
  }
  return null;
}
/** Speak now (relative to the video) and return the clip duration in ms. */
function speakAt(voice, text) {
  if (!NARRATE) return Math.min(6000, 600 + text.split(/\s+/).length * 320);
  const clip = text.trim() ? synth(voice, text) : null;
  if (!clip) return 1500; // keep the timing; skip the voice rather than abort the take
  clips.push({ file: clip.file, wall: Date.now() / 1000 });
  return Math.round(clip.dur * 1000);
}

// ── browser + screencast capture ────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const frames = []; // {file, t}
let n = 0;
cdp.on("Page.screencastFrame", async (f) => {
  const file = `${WORK}/f${String(n++).padStart(6, "0")}.jpg`;
  writeFileSync(file, Buffer.from(f.data, "base64"));
  frames.push({ file, t: f.metadata.timestamp });
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
const startCapture = () => cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1, maxWidth: W, maxHeight: H });

// ── page helpers ────────────────────────────────────────────────────────────────
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
const assistantCount = () => page.locator('[data-role="assistant"]').count();
const lastAssistantText = () => page.evaluate(() => {
  const all = document.querySelectorAll('[data-role="assistant"]');
  const span = all[all.length - 1]?.querySelector("span:nth-child(2)");
  return span?.childNodes[0]?.textContent?.trim() ?? "";
});
const input = () => page.getByPlaceholder("…or type what you would say");

/** Customer says (and types) a line, then Butler's reply is spoken when it appears. */
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1);
async function say(text, { after = 400 } = {}) {
  console.log(`[${el()}s] you: ${text}`);
  const before = await assistantCount();
  await input().click();
  const ms = speakAt(VOICES.you, text);
  await page.keyboard.type(text, { delay: Math.max(18, Math.min(80, Math.round((ms * 0.85) / text.length))) });
  await sleep(250);
  await page.keyboard.press("Enter");
  await page.waitForFunction((b) => document.querySelectorAll('[data-role="assistant"]').length > b, before, { timeout: 25000 }).catch(() => {});
  await sleep(350);
  const reply = await lastAssistantText();
  console.log(`[${el()}s] butler: ${reply}`);
  await sleep(reply ? speakAt(VOICES.butler, reply) + after : 3000);
}
async function narrate(text, pad = 600) { await sleep(speakAt(VOICES.narrator, text) + pad); }

// ── run ─────────────────────────────────────────────────────────────────────────
await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.reload({ waitUntil: "networkidle" });
await sleep(1500);
await page.getByRole("button", { name: "Smart display 15" }).click();
await sleep(800);

await startCapture();
await sleep(300);
await overlay("Butler", "An Alexa+ add-on that acts for you, shows a receipt for every action,<br/>and turns your corrections into rules the AI cannot break.", { full: true });
await narrate("Meet Butler: an Alexa plus add-on that acts for you, and shows its receipts.", 500);
await clearOverlay();

await overlay("1 · Describe a situation", "Not a command. Butler works out what it needs.");
await say("Tell Butler six friends from the dinner crew are coming over Friday at 7.", { after: 1300 });

await overlay("2 · It handles what it can, and asks about the rest", "Invites sent, calendar set, drinks bought. Cleaning needs your call.");
await say("How's Friday looking?", { after: 700 });

await overlay("3 · Tap a screen, or just say it", "Choosing runs through the approval path, not the AI.");
let clicked = false;
for (const f of page.frames()) {
  const btn = f.getByRole("button", { name: "Choose" }).first();
  if (await btn.count().catch(() => 0)) { await btn.click({ timeout: 3000 }).catch(() => {}); clicked = true; break; }
}
if (clicked) {
  await sleep(1300);
  let spoken = "";
  for (const f of page.frames()) {
    const t = await f.locator("text=/approved it/i").first().textContent({ timeout: 500 }).catch(() => "");
    if (t) { spoken = t.trim(); break; }
  }
  await sleep(speakAt(VOICES.butler, spoken || "I booked BrightHome for 85 dollars. You approved it.") + 700);
} else {
  await say("Book BrightHome.");
}

await overlay("4 · Every action has a receipt", "What it did, why, what it rejected, and which rule allowed it.");
await say("Why did you buy the drinks?", { after: 1300 });

await overlay("5 · Object once, and it becomes a rule", "The AI drafts it; deterministic code compiles it to policy.");
await say("Don't buy drinks without asking me.");
await say("Yes.", { after: 700 });

await overlay("6 · Next time, the rule blocks it. Watch the panel.", "The gateway denies the purchase before anything is bought.");
await say("I'm travelling Thursday to Sunday. My parents are staying at the house.", { after: 700 });
await overlay("The DENY is enforced outside the AI", "Butler stops and asks you instead of buying.");
await sleep(1500);
await say("Anything you need from me?", { after: 700 });

await overlay("7 · See what it did that you might disagree with", "");
await say("What did you do this week that I might disagree with?", { after: 1200 });

await overlay("Alexa can act for you without being a black box.", "Every action has a receipt. Every correction becomes a rule.", { full: true });
await narrate("Alexa can act for you, without being a black box.", 1200);

await cdp.send("Page.stopScreencast").catch(() => {});
await browser.close();

// ── encode video ────────────────────────────────────────────────────────────────
if (frames.length < 10) { console.error("too few frames captured:", frames.length); process.exit(1); }
const t0 = frames[0].t;
const end = Date.now() / 1000;
const list = [];
for (let i = 0; i < frames.length; i++) {
  const next = frames[i + 1]?.t ?? end;
  list.push(`file '${frames[i].file}'`, `duration ${Math.max(0.02, next - frames[i].t).toFixed(3)}`);
}
list.push(`file '${frames.at(-1).file}'`);
writeFileSync(`${WORK}/list.txt`, list.join("\n"));
const silent = NARRATE ? `${WORK}/video.mp4` : OUT;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${WORK}/list.txt`,
  "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", silent], { stdio: "inherit" });

// ── mix narration onto the video ─────────────────────────────────────────────────
if (NARRATE) {
  const skew = Math.abs(t0 - (clips[0]?.wall ?? t0));
  if (skew > 30) console.warn(`warning: screencast clock and wall clock differ by ${skew.toFixed(1)} s; audio may be misaligned`);
  const inputs = clips.flatMap((c) => ["-i", c.file]);
  const delays = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.max(0, Math.round((c.wall - t0) * 1000))}:all=1[a${i}]`);
  const mix = `${delays.join(";")};${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,volume=1.6,alimiter=limit=0.95,apad[aout]`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", silent, ...inputs, "-filter_complex", mix,
    "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", OUT], { stdio: "inherit" });
}
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT]).toString().trim();
console.log(`wrote ${OUT}  (${frames.length} frames, ${clips.length} voice clips, ${Number(dur).toFixed(1)} s)`);
rmSync(WORK, { recursive: true, force: true });
