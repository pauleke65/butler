import { build, context } from "esbuild";

const options = {
  entryPoints: ["src/panel.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/panel.js",
  minify: !process.argv.includes("--watch"),
  sourcemap: false,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching src/ ...");
} else {
  await build(options);
}
