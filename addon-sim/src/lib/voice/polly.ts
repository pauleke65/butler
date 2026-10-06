import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from "@aws-sdk/client-polly";

export interface PollyLike {
  send(cmd: SynthesizeSpeechCommand): Promise<{ AudioStream?: { transformToByteArray(): Promise<Uint8Array> } }>;
}

export interface SynthOptions {
  voiceId?: string;
  region?: string;
  client?: PollyLike;
}

/** Amazon Polly neural voice -> MP3 bytes. Uses the default AWS credential chain. */
export async function synthesize(text: string, opts: SynthOptions = {}): Promise<Uint8Array> {
  const client = opts.client ?? (new PollyClient({ region: opts.region ?? process.env.AWS_REGION ?? "us-east-1" }) as unknown as PollyLike);
  const res = await client.send(
    new SynthesizeSpeechCommand({
      Text: text.slice(0, 2900),
      OutputFormat: "mp3",
      Engine: "neural",
      VoiceId: (opts.voiceId ?? process.env.POLLY_VOICE_ID ?? "Joanna") as VoiceId,
      TextType: "text",
    }),
  );
  if (!res.AudioStream) throw new Error("Polly returned no audio");
  return res.AudioStream.transformToByteArray();
}

/** Polly is only used when a real LLM mode is on; offline runs never touch AWS. */
export function pollyAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.LLM_MODE === "bedrock" && env.TTS_DISABLE_POLLY !== "1";
}
