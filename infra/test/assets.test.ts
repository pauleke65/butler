import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resourcesOfType, synth } from "./helpers";

describe("build assets", () => {
  it("synth fails with a clear, actionable message when infra/dist is missing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "butler-dist-"));
    expect(() => synth({ stubAssets: "false", distDir: empty })).toThrow(/Build asset "actions" not found[\s\S]*build-lambdas\.sh/);
  });

  it("names the runtime build script when only the runtimes are missing", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "butler-dist-"));
    for (const d of ["actions", "executor", "debug-api"]) {
      fs.mkdirSync(path.join(dist, d));
      fs.writeFileSync(path.join(dist, d, "x.py"), "");
    }
    expect(() => synth({ stubAssets: "false", distDir: dist })).toThrow(/agent-runtime[\s\S]*build-runtimes\.sh agent/);
  });

  it("synthesizes against a complete dist directory", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "butler-dist-"));
    for (const d of ["actions", "executor", "debug-api", "agent-runtime", "server-runtime"]) {
      fs.mkdirSync(path.join(dist, d));
      fs.writeFileSync(path.join(dist, d, "x"), d);
    }
    const { json } = synth({ stubAssets: "false", distDir: dist });
    expect(resourcesOfType(json, "AWS::BedrockAgentCore::Runtime")).toHaveLength(2);
  });

  it("container mode swaps in image artifacts (needs Docker only at deploy time)", () => {
    const { json } = synth({ runtimeArtifact: "container" });
    const runtimes = resourcesOfType(json, "AWS::BedrockAgentCore::Runtime");
    for (const [, r] of runtimes) {
      expect(r.Properties!["AgentRuntimeArtifact"].ContainerConfiguration.ContainerUri).toBeDefined();
      expect(r.Properties!["AgentRuntimeArtifact"].CodeConfiguration).toBeUndefined();
    }
  });
});
