import { describe, expect, it } from "vitest";
import { pollyAllowed, synthesize, type PollyLike } from "./polly";

describe("polly", () => {
  it("requests a neural mp3 with the configured voice and returns the audio bytes", async () => {
    let input: Record<string, unknown> = {};
    const client: PollyLike = {
      send: async (cmd) => {
        input = cmd.input as unknown as Record<string, unknown>;
        return { AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
      },
    };
    const audio = await synthesize("Hello there", { voiceId: "Matthew", client });
    expect(Array.from(audio)).toEqual([1, 2, 3]);
    expect(input).toMatchObject({ Engine: "neural", OutputFormat: "mp3", VoiceId: "Matthew", Text: "Hello there" });
  });
  it("defaults to Joanna and fails clearly without audio", async () => {
    let voice = "";
    const client: PollyLike = { send: async (cmd) => { voice = (cmd.input as { VoiceId: string }).VoiceId; return {}; } };
    await expect(synthesize("x", { client })).rejects.toThrow(/no audio/);
    expect(voice).toBe(process.env.POLLY_VOICE_ID ?? "Joanna");
  });
  it("is only allowed in bedrock mode", () => {
    expect(pollyAllowed({})).toBe(false);
    expect(pollyAllowed({ LLM_MODE: "offline" })).toBe(false);
    expect(pollyAllowed({ LLM_MODE: "bedrock" })).toBe(true);
    expect(pollyAllowed({ LLM_MODE: "bedrock", TTS_DISABLE_POLLY: "1" })).toBe(false);
  });
});
