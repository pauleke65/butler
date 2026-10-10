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
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
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
// The walkthrough has one human voice: the presenter narrates and also talks to the Echo.
const MODE = arg("mode", "explainer"); // explainer: chapter banners + narrator; walkthrough: presenter, camera moves, no banners
if (MODE === "walkthrough" && TTS === "polly") {
  VOICES.you = process.env.VOICE_YOU ?? "Stephen";
  VOICES.narrator = process.env.VOICE_NARRATOR ?? "Stephen";
}
const LONG_FORM = new Set(["Gregory", "Patrick"]);
const POLLY_ENGINE = Object.fromEntries(Object.values(VOICES).map((v) => [v, LONG_FORM.has(v) ? "long-form" : "generative"]));
const REPLY_TIMEOUT_MS = Number(process.env.REPLY_TIMEOUT_MS ?? "45000"); // AgentCore cold starts can take ~10 s
const TEMPO = Number(process.env.TTS_TEMPO ?? (TTS === "polly" ? "1.12" : "1")); // Polly speaks slowly; keep the take under 3:00

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/audio`, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

// ── speech (local macOS voices) ────────────────────────────────────────────────
let clipN = 0;
const clips = []; // {file, wall}
const RATE = { [VOICES.you]: "225", [VOICES.butler]: "215", [VOICES.narrator]: "205" };
// Clips are cached by (voice, text) so a network blip can't ruin a take; `--prewarm lines.json` fills the cache first.
const CACHE = resolve(here, ".tts-cache");
mkdirSync(CACHE, { recursive: true });
function cacheFile(voice, text) {
  const key = createHash("sha1").update(`${TTS}|${voice}|${TEMPO}|${text}`).digest("hex").slice(0, 16);
  return `${CACHE}/${key}.wav`;
}
function render(voice, text, out) {
  const raw = `${out}.${TTS === "polly" ? "mp3" : "aiff"}`;
  if (TTS === "polly") {
    execFileSync("aws", ["polly", "synthesize-speech", "--engine", POLLY_ENGINE[voice] ?? "generative", "--voice-id", voice,
      "--output-format", "mp3", "--text", text, raw], { stdio: "pipe" });
  } else {
    execFileSync("say", ["-v", voice, "-r", RATE[voice] ?? "200", "-o", raw, "--", text], { stdio: "pipe" });
  }
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-af", `atempo=${TEMPO}`, "-ar", "44100", out]);
  rmSync(raw, { force: true });
}
function synth(voice, text) {
  const file = cacheFile(voice, text);
  if (!existsSync(file)) {
    for (let attempt = 1; ; attempt++) {
      try { render(voice, text, file); break; } catch (e) {
        console.warn(`tts failed (attempt ${attempt}) for "${text.slice(0, 40)}": ${String(e.stderr ?? e.message).trim().slice(0, 120)}`);
        if (attempt >= 6) return null;
        execFileSync("sleep", [String(Math.min(8, attempt * 1.5))]);
      }
    }
  }
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
  return { file, dur };
}
if (process.argv.includes("--prewarm")) {
  const list = JSON.parse(readFileSync(resolve(arg("prewarm")), "utf8"));
  let ok = 0;
  for (const { role, text } of list) if (synth(VOICES[role], text)) ok++;
  console.log(`prewarmed ${ok}/${list.length} clips`);
  if (ok < list.length) process.exit(1);
}
// --voice-dir: your own recordings, one file per clip id (01.wav, 02.m4a, ...; see split-voicenote.py). A clip id with a
// file plays your voice; anything else falls back to the TTS voice.
const VOICE_DIR = arg("voice-dir") ? resolve(arg("voice-dir")) : undefined;
function userClip(id) {
  if (!VOICE_DIR || !id) return null;
  const src = ["wav", "m4a", "mp3", "aif", "aiff"].map((ext) => `${VOICE_DIR}/${id}.${ext}`).find((f) => existsSync(f));
  if (!src) return null;
  const file = `${WORK}/audio/user-${id}.wav`;
  if (!existsSync(file)) execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-ar", "44100", "-ac", "1", file]);
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
  return { file, dur };
}

/** Speak now (relative to the video) and return the clip duration in ms. */
function speakAt(voice, text, clipId) {
  if (!NARRATE) return Math.min(6000, 600 + text.split(/\s+/).length * 320);
  const clip = userClip(clipId) ?? (text.trim() ? synth(voice, text) : null);
  if (!clip) return 1500; // keep the timing; skip the voice rather than abort the take
  clips.push({ file: clip.file, wall: Date.now() / 1000 });
  return Math.round(clip.dur * 1000);
}

// ── browser + screencast capture ────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
// The simulator speaks replies with the browser's speechSynthesis; in headless Edge that blocks the page for the
// length of the utterance, so typing and screen changes show up late. Narration comes from our own mix, so replace it
// with a silent stand-in that fires start/end events on the normal schedule without blocking.
await ctx.addInitScript(() => {
  // diagnostics: record main-thread long tasks (>= 50 ms) with wall-clock start times
  try {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push([Math.round(performance.timeOrigin + e.startTime), Math.round(e.duration)]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
});
await ctx.addInitScript(() => {
  const synth = window.speechSynthesis;
  if (!synth) return;
  const fire = (u, type) => { try { u.dispatchEvent(new Event(type)); } catch {} try { u["on" + type]?.(new Event(type)); } catch {} };
  synth.speak = (u) => {
    const ms = Math.min(9000, 400 + String(u.text || "").split(/\s+/).length * 280);
    setTimeout(() => fire(u, "start"), 0);
    setTimeout(() => fire(u, "end"), ms);
  };
  synth.cancel = () => {};
});
const cdp = await ctx.newCDPSession(page);
const frames = []; // {file, t}
let n = 0;
// Capture: CAPTURE=screenshots (default) grabs Page.captureScreenshot on a steady clock, each frame stamped with when
// it was taken. The DevTools screencast (CAPTURE=screencast) built up a ~5 s backlog in long takes while stamping
// frames on arrival, so the picture drifted behind the narration.
const CAPTURE = process.env.CAPTURE ?? "screenshots";
const FPS = Number(process.env.CAPTURE_FPS ?? "12");
let capturing = false;
let captureWall = 0;
let captureLoop = Promise.resolve();
cdp.on("Page.screencastFrame", async (f) => {
  const file = `${WORK}/f${String(n++).padStart(6, "0")}.jpg`;
  writeFileSync(file, Buffer.from(f.data, "base64"));
  frames.push({ file, t: f.metadata.timestamp, arrived: Date.now() / 1000 });
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
async function screenshotLoop() {
  const every = 1000 / FPS;
  while (capturing) {
    const started = Date.now();
    try {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 82, optimizeForSpeed: true });
      const t = (started + Date.now()) / 2 / 1000; // mid-point of the capture
      const file = `${WORK}/f${String(n++).padStart(6, "0")}.jpg`;
      writeFileSync(file, Buffer.from(data, "base64"));
      frames.push({ file, t, arrived: Date.now() / 1000 });
    } catch { /* page navigating or busy: skip this tick */ }
    const wait = every - (Date.now() - started);
    if (wait > 0) await sleep(wait);
  }
}
const startCapture = async () => {
  captureWall = Date.now() / 1000;
  if (CAPTURE === "screencast") return cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1, maxWidth: W, maxHeight: H });
  capturing = true;
  captureLoop = screenshotLoop();
};

// ── page helpers ────────────────────────────────────────────────────────────────
async function overlay(title, sub, { full = false } = {}) {
  await page.evaluate(({ title, sub, full }) => {
    let el = document.getElementById("__cap");
    if (!el) { el = document.createElement("div"); el.id = "__cap"; document.body.appendChild(el); }
    // same family as the simulator: Alexa navy, Figtree, no borders
    el.style.cssText = full
      ? "position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:22px;background:radial-gradient(70% 60% at 30% 45%,#16243a 0%,#0b0c0f 70%);color:#eceef2;font:500 76px/1.08 Figtree,system-ui,sans-serif;letter-spacing:-0.02em;padding:0 180px;"
      : "position:fixed;left:50%;transform:translateX(-50%);top:12px;z-index:99999;max-width:1100px;background:#1b1e23;border-radius:22px;color:#eceef2;font:600 22px/1.3 Figtree,system-ui,sans-serif;letter-spacing:-0.01em;padding:14px 26px 15px;text-align:center;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 18px 40px -16px rgba(0,0,0,.85);";
    el.innerHTML = `<div style="text-wrap:balance">${title}</div>${sub ? `<div style="font:400 ${full ? 30 : 16}px/1.4 Figtree,system-ui,sans-serif;letter-spacing:0;color:#a3a9b4;margin-top:${full ? 0 : 4}px;max-width:${full ? 1100 : 1000}px;text-wrap:balance">${sub}</div>` : ""}`;
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
async function say(text, { after = 400, clip, typed } = {}) {
  console.log(`[${el()}s] you: ${text}`);
  const before = await assistantCount();
  await input().evaluate((el) => el.focus({ preventScroll: true })); // focusing must not scroll the zoomed page
  const ms = speakAt(VOICES.you, text, clip);
  const shown = typed ?? text; // what lands in the transcript box (e.g. "7" where you say "seven")
  await page.keyboard.type(shown, { delay: Math.max(18, Math.min(80, Math.round((ms * 0.85) / shown.length))) });
  await sleep(250);
  await page.keyboard.press("Enter");
  await page.waitForFunction((b) => document.querySelectorAll('[data-role="assistant"]').length > b, before, { timeout: REPLY_TIMEOUT_MS }).catch(() => {});
  await sleep(350);
  const reply = await lastAssistantText();
  console.log(`[${el()}s] butler: ${reply}`);
  await sleep(reply ? speakAt(VOICES.butler, reply) + after : 3000);
}
async function narrate(text, pad = 600, clip) { await sleep(speakAt(VOICES.narrator, text, clip) + pad); }

// ── run ─────────────────────────────────────────────────────────────────────────
await page.goto(BASE, { waitUntil: "networkidle" });
// Simulator voice off: narration comes from our mix, and while the simulator "speaks" (Polly fetch, then the browser
// voice, up to ~9 s) typed lines queue behind it, which made the picture lag the audio.
await page.evaluate(() => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("addon-sim.settings.v1", JSON.stringify({ voice: { engine: "off", pollyVoiceId: "Joanna", browserVoiceName: "" } }));
});
await page.reload({ waitUntil: "networkidle" });
await sleep(1500);
await page.getByRole("button", { name: "Smart display 8" }).click();
await sleep(800);

async function explainer() {
  await startCapture();
  await sleep(300);
  await overlay("Butler", "An Alexa+ add-on that acts for you, shows a receipt for every action, and turns your corrections into rules the AI cannot break.", { full: true });
  await narrate("Meet Butler: an Alexa plus add-on that acts for you, and shows its receipts.", 500);
  await clearOverlay();

  await overlay("Describe a situation", "Not a command. Butler works out what it needs.");
  await say("Tell Butler six friends from the dinner crew are coming over Friday at 7.", { after: 1300 });

  await overlay("It handles what it can, and asks about the rest", "Invites sent, calendar set, drinks bought. Cleaning needs your call.");
  await say("How's Friday looking?", { after: 700 });

  await overlay("Tap a screen, or just say it", "Choosing runs through the approval path, not the AI.");
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

  await overlay("Every action has a receipt", "What it did, why, what it rejected, and which rule allowed it.");
  await say("Why did you buy the drinks?", { after: 1300 });

  await overlay("Object once, and it becomes a rule", "The AI drafts it; deterministic code compiles it to policy.");
  await say("Don't buy drinks without asking me.");
  await say("Yes.", { after: 700 });

  await overlay("Next time, the rule blocks it. Watch the panel.", "The gateway denies the purchase before anything is bought.");
  await say("I'm travelling Thursday to Sunday. My parents are staying at the house.", { after: 700 });
  await overlay("The DENY is enforced outside the AI", "Butler stops and asks you instead of buying.");
  await sleep(1500);
  await say("Anything you need from me?", { after: 700 });

  await overlay("See what it did that you might disagree with", "");
  await say("What did you do this week that I might disagree with?", { after: 1200 });

  await overlay("Alexa can act for you without being a black box.", "Every action has a receipt. Every correction becomes a rule.", { full: true });
  await narrate("Alexa can act for you, without being a black box.", 1200);

}

// ── walkthrough: the submitter presents, no banners; an in-page camera frames what matters ─────────────────────
const DEVICE = '[data-testid="device-frame"]';
const BLACK_BOX = "[data-attention]";

/** Ease the page onto one element or the union of several (a CSS transform on the app root, so text stays crisp). */
async function camera(target, { pad = 28, ms = 1150, height, maxScale = 2 } = {}) {
  await page.evaluate(({ target, pad, ms, height, maxScale, W, H }) => {
    const cur = window.__cam ?? { s: 1, tx: 0, ty: 0 };
    let next = { s: 1, tx: 0, ty: 0 };
    if (target !== "full") {
      const rects = (Array.isArray(target) ? target : [target])
        .map((q) => document.querySelector(q)?.getBoundingClientRect())
        .filter(Boolean)
        .map((r) => ({ x: (r.left - cur.tx) / cur.s, y: (r.top - cur.ty) / cur.s, w: r.width / cur.s, h: r.height / cur.s })); // undo the current camera
      if (!rects.length) return;
      const x0 = Math.min(...rects.map((r) => r.x));
      const y0 = Math.min(...rects.map((r) => r.y));
      const x1 = Math.max(...rects.map((r) => r.x + r.w));
      const y1 = height ? y0 + height : Math.max(...rects.map((r) => r.y + r.h));
      const s = Math.min(W / (x1 - x0 + 2 * pad), H / (y1 - y0 + 2 * pad), maxScale);
      const tx = Math.min(0, Math.max(W - s * W, W / 2 - (s * (x0 + x1)) / 2));
      const ty = Math.min(0, Math.max(H - s * H, H / 2 - (s * (y0 + y1)) / 2));
      next = { s, tx, ty };
    }
    // move the app's root, not <body>: <body> clips (see walkthrough()), so nothing can scroll the zoomed view away
    const b = [...document.body.children].find((c) => c.contains(document.querySelector('[data-testid="stage"]'))) ?? document.body;
    b.style.transformOrigin = "0 0";
    b.style.transition = `transform ${ms}ms cubic-bezier(0.65, 0, 0.35, 1)`;
    b.style.transform = next.s === 1 ? "none" : `translate(${next.tx}px, ${next.ty}px) scale(${next.s})`;
    window.__cam = next;
  }, { target, pad, ms, height, maxScale, W, H });
  await sleep(ms + 60);
}

async function fadeOverlay(ms = 550) {
  await page.evaluate((ms) => {
    const el = document.getElementById("__cap");
    if (!el) return;
    el.style.transition = `opacity ${ms}ms ease-out`;
    el.style.opacity = "0";
    setTimeout(() => el.remove(), ms + 20);
  }, ms);
  await sleep(ms + 40);
}

async function denyLanded(timeout = 30000) {
  await page
    .waitForFunction(() => document.querySelector('[data-testid^="panel-"]')?.shadowRoot?.querySelector('[data-decision="DENY"]'), null, { timeout })
    .catch(() => console.warn("no DENY row seen in the Black Box"));
}

/** Wait until the Black Box shows something (the cloud agent works in the background). */
async function blackBox(what, timeout = 60000) {
  const ok = await page
    .waitForFunction((what) => {
      const root = document.querySelector('[data-testid^="panel-"]')?.shadowRoot;
      if (!root) return false;
      const rows = [...root.querySelectorAll('[data-testid="feed-row"]')].map((r) => r.textContent ?? "");
      const rules = [...root.querySelectorAll('[data-testid="rule-row"]')].map((r) => r.textContent ?? "");
      if (what === "plan-work") return rows.some((t) => t.includes("$42.00")) && rows.some((t) => t.includes("search_providers"));
      if (what === "rule-active") return rules.some((t) => t.includes("buying drinks") && t.includes("Ask first"));
      return false;
    }, what, { timeout, polling: 500 })
    .then(() => true, () => false);
  console.log(`[${el()}s] black box ${what}: ${ok ? "seen" : "TIMED OUT"}`);
}

// The presenter's clips (docs/demo/voiceover-script.md); ids match your recordings in --voice-dir.
const SCRIPT = Object.fromEntries(JSON.parse(readFileSync(resolve(here, "walkthrough-script.json"), "utf8")).map((c) => [c.id, c]));

async function walkthrough() {
  const pres = (id, pad = 350) => narrate(SCRIPT[id].text, pad, id);
  const line = (id, opts = {}) => say(SCRIPT[id].text, { ...opts, clip: id, ...(SCRIPT[id].type ? { typed: SCRIPT[id].type } : {}) });
  // The camera transforms <body>; typing into the transcript box would otherwise scroll the page to reveal it.
  await page.addStyleTag({ content: "html { overflow: hidden !important; } body { overflow: clip !important; height: 100vh !important; }" });
  await startCapture();
  await sleep(300);
  await overlay("Butler", "An Alexa+ add-on that acts for you, keeps a receipt for every action, and turns your corrections into rules the AI can't break.", { full: true });
  await pres("01", 450);
  await fadeOverlay();
  await pres("02", 200);

  await camera(DEVICE);
  await pres("03", 150);
  await line("04", { after: 250 });
  await pres("05", 350);
  await blackBox("plan-work");

  await pres("06", 150);
  await line("07", { after: 250 });
  await pres("08", 100);
  let spoken = "";
  for (const f of page.frames()) {
    const btn = f.getByRole("button", { name: "Choose" }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      break;
    }
  }
  for (let i = 0; i < 20 && !spoken; i++) {
    await sleep(250);
    for (const f of page.frames()) {
      const t = await f.locator("text=/approved it/i").first().textContent({ timeout: 200 }).catch(() => "");
      if (t) { spoken = t.trim(); break; }
    }
  }
  console.log(`[${el()}s] butler (tap): ${spoken}`);
  await sleep(speakAt(VOICES.butler, spoken || "I booked a cleaner for 85 dollars. You approved it.") + 250);
  await pres("09", 400);

  await pres("10", 100);
  await line("11", { after: 250 });
  await pres("12", 450);

  await line("13", { after: 150 });
  await line("14", { after: 200 });
  await camera(BLACK_BOX, { maxScale: 1.45 });
  await blackBox("rule-active", 45000); // in force at the gateway, so the next DENY is AgentCore's
  await pres("15", 300);

  await camera([DEVICE, BLACK_BOX], { pad: 20 });
  await line("16", { after: 0 });
  await denyLanded();
  await camera(BLACK_BOX, { height: 330, maxScale: 1.9, ms: 1000 });
  await pres("17", 450);

  await camera(DEVICE);
  await line("18", { after: 150 });
  await pres("19", 350);
  await line("20", { after: 250 });
  await sleep(500);

  await camera("full", { ms: 900 });
  await overlay("Butler", "Amazon Bedrock AgentCore Runtime, Gateway and Policy · Cedar · Cognito · DynamoDB · AWS CDK<br/>Open-source simulator: addon-sim", { full: true });
  await pres("21", 1300);
}

if (MODE === "walkthrough") await walkthrough();
else await explainer();

const longTasks = await page.evaluate(() => window.__longTasks || []).catch(() => []);
capturing = false;
await captureLoop;
await cdp.send("Page.stopScreencast").catch(() => {});
await browser.close();

// ── capture diagnostics: big gaps between frames, and frames that arrived long after they were painted ──
{
  const gaps = [];
  for (let i = 1; i < frames.length; i++) {
    const gap = frames[i].t - frames[i - 1].t;
    const late = frames[i].arrived - frames[i].t;
    if (gap > 2 || late > 1) gaps.push(`frame ${i} at ${(frames[i].t - frames[0].t).toFixed(1)}s: gap ${gap.toFixed(1)}s, arrived ${late.toFixed(1)}s after paint`);
  }
  console.log(`capture: ${frames.length} frames; ${gaps.length} anomalies`);
  const heavy = longTasks.filter(([, d]) => d >= 200);
  console.log(`main-thread long tasks: ${longTasks.length} (>=200 ms: ${heavy.length}, total ${longTasks.reduce((a, [, d]) => a + d, 0)} ms)`);
  for (const [at, d] of heavy.slice(0, 30)) console.log(`  long task at ${(at / 1000 - captureWall).toFixed(1)}s for ${d} ms`);
  for (const g of gaps.slice(0, 25)) console.log("  " + g);
}

// ── encode video ────────────────────────────────────────────────────────────────
if (frames.length < 10) { console.error("too few frames captured:", frames.length); process.exit(1); }
// The first screencast frame is the last thing Chrome painted, stamped with when it was painted, which can be
// seconds before capture began. Anchor the timeline at the moment capture started so audio lines up.
frames[0].t = Math.max(frames[0].t, captureWall);
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
