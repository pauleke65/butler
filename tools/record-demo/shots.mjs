// Design review captures: drives the simulator through the golden demo and saves a 1600x900 screenshot per step.
//   node tools/record-demo/shots.mjs [--out .impeccable/review] [--device display-8]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = resolve(arg("out", ".impeccable/review"));
const BASE = arg("base", "http://localhost:3000");
const DEVICE = arg("device", "Smart display 8");
const [VW, VH] = arg("viewport", "1600x900").split("x").map(Number);
const EDGE = process.env.BROWSER_PATH ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
const page = await (await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 })).newPage();
await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("addon-sim.settings.v1", JSON.stringify({ voice: { engine: "off", pollyVoiceId: "Joanna", browserVoiceName: "" } }));
});
await page.reload({ waitUntil: "networkidle" });
await sleep(1200);
await page.getByRole("button", { name: DEVICE }).click();
await sleep(600);
await page.screenshot({ path: `${OUT}/00-home.png` });

const input = () => page.getByPlaceholder("…or type what you would say");
async function say(text, shot, wait = 2600) {
  const before = await page.locator('[data-role="assistant"]').count();
  await input().click();
  await input().fill(text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((b) => document.querySelectorAll('[data-role="assistant"]').length > b, before, { timeout: 25000 }).catch(() => {});
  await sleep(wait);
  await page.evaluate(() => window.scrollTo(0, 0)); // typing scrolls the stacked mobile layout to the input
  if (shot) await page.screenshot({ path: `${OUT}/${shot}.png` });
}

await say("Tell Butler six friends from the dinner crew are coming over Friday at 7.", "01-situation");
await say("How's Friday looking?", "02-status");
for (const f of page.frames()) {
  const b = f.getByRole("button", { name: "Choose" }).first();
  if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); break; }
}
await sleep(2200);
await page.screenshot({ path: `${OUT}/03-chosen.png` });
await say("Why did you buy the drinks?", "04-receipt");
await say("Don't buy drinks without asking me.", "05-rule-draft");
await say("Yes.", "06-rule-active", 3500);
await say("I'm travelling Thursday to Sunday. My parents are staying at the house.", null, 0);
// The DENY arrives a moment after the reply (the agent works in the background): capture while the card is lit.
await page.waitForFunction(() => document.querySelector('[data-testid^="panel-"]')?.shadowRoot?.querySelector('[data-decision="DENY"]'), null, { timeout: 30000 });
await page.waitForSelector('[data-attention="alert"]', { timeout: 5000 }).catch(() => {});
await page.evaluate(() => window.scrollTo(0, 0));
await sleep(350);
await page.screenshot({ path: `${OUT}/07-deny.png` });
await sleep(2000);
await say("Anything you need from me?", "08-approval");
await say("What did you do this week that I might disagree with?", "09-might");
await browser.close();
console.log(`saved to ${OUT}`);
