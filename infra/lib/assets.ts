import * as fs from "node:fs";
import * as path from "node:path";
import { INFRA_ROOT, type ButlerConfig } from "./config";

export type AssetName = "actions" | "executor" | "debug-api" | "agent-runtime" | "server-runtime";

const BUILD_HINT: Record<AssetName, string> = {
  actions: "bash infra/scripts/build-lambdas.sh",
  executor: "bash infra/scripts/build-lambdas.sh",
  "debug-api": "bash infra/scripts/build-lambdas.sh",
  "agent-runtime": "bash infra/scripts/build-runtimes.sh agent",
  "server-runtime": "bash infra/scripts/build-runtimes.sh server",
};

export const STUB_ASSET_DIR = path.join(INFRA_ROOT, "test/fixtures/stub-asset");

/**
 * Directory of a pre-built asset. Fails synth with a clear message when it has not been built
 * (the build scripts need no Docker, so this is a one-liner to fix). `-c stubAssets=true` is for unit tests only.
 */
export function assetDir(config: ButlerConfig, name: AssetName): string {
  if (config.stubAssets) return STUB_ASSET_DIR;
  const dir = path.join(config.distDir, name);
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
    throw new Error(
      `Build asset "${name}" not found at ${dir}.\n` +
        `Build it first:  ${BUILD_HINT[name]}\n` +
        `(or build everything: cd infra && pnpm build:lambdas && pnpm build:runtimes)`,
    );
  }
  return dir;
}
