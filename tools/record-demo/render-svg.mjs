// Renders an SVG to PNG with headless Edge/Chrome: node render-svg.mjs <in.svg> <out.png>
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const [inp, out] = process.argv.slice(2).map((p) => resolve(p));
const svg = readFileSync(inp, "utf8");
const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
const [w, h] = m ? [Number(m[1]), Number(m[2])] : [1600, 900];
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: w, height: h } });
await browser.close();
console.log("wrote", out);
