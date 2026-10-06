/**
 * Speech output. Prefers Amazon Polly (via /api/tts) when the server allows it; falls back automatically to the
 * browser's speechSynthesis when Polly is unavailable (offline mode, no credentials, network error).
 * `stop()` implements barge-in.
 */
export type TtsEngine = "polly" | "browser" | "none";

export interface SpeakerOptions {
  /** "auto" tries Polly first, "browser" never calls the API, "off" is silent (captions only). */
  engine(): "auto" | "browser" | "off";
  pollyVoiceId(): string;
  browserVoiceName(): string;
  onState(state: { speaking: boolean; engine: TtsEngine }): void;
}

export class Speaker {
  private audio?: HTMLAudioElement;
  private url?: string;
  private abort?: AbortController;
  private token = 0;
  private pollyDownUntil = 0;

  constructor(private readonly o: SpeakerOptions) {}

  get supportsBrowserSpeech(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /** Speak `text`; resolves when playback ends or is interrupted. Returns the engine that was used. */
  async speak(text: string): Promise<TtsEngine> {
    this.stop();
    const my = ++this.token;
    const engine = this.o.engine();
    if (engine === "off" || !text.trim()) return "none";

    if (engine === "auto" && Date.now() > this.pollyDownUntil) {
      this.abort = new AbortController();
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, voiceId: this.o.pollyVoiceId() }),
          signal: this.abort.signal,
        });
        if (my !== this.token) return "none";
        if (res.ok) {
          const blob = await res.blob();
          if (my !== this.token) return "none";
          await this.play(blob, my);
          return "polly";
        }
        // 503 = not allowed / unavailable: remember for a minute so we do not retry on every reply.
        this.pollyDownUntil = Date.now() + 60_000;
      } catch (err) {
        if ((err as Error).name === "AbortError") return "none";
        this.pollyDownUntil = Date.now() + 60_000;
      }
    }
    if (my !== this.token) return "none";
    if (!this.supportsBrowserSpeech) return "none";
    await this.browserSpeak(text, my);
    return "browser";
  }

  private play(blob: Blob, my: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.url = URL.createObjectURL(blob);
      const a = new Audio(this.url);
      this.audio = a;
      const done = () => {
        if (this.audio === a) this.cleanup();
        if (my === this.token) this.o.onState({ speaking: false, engine: "polly" });
        resolve();
      };
      a.onended = done;
      a.onerror = done;
      this.o.onState({ speaking: true, engine: "polly" });
      a.play().catch(done);
    });
  }

  private browserSpeak(text: string, my: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const name = this.o.browserVoiceName();
      const voice = name ? window.speechSynthesis.getVoices().find((v) => v.name === name) : undefined;
      if (voice) u.voice = voice;
      u.rate = 1;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        if (my === this.token) this.o.onState({ speaking: false, engine: "browser" });
        resolve();
      };
      // Some environments (headless browsers, no audio device) never fire onend; do not stay "speaking" forever.
      const guard = setTimeout(done, 3000 + text.length * 90);
      u.onend = done;
      u.onerror = done;
      this.o.onState({ speaking: true, engine: "browser" });
      window.speechSynthesis.speak(u);
    });
  }

  private cleanup(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
    this.audio = undefined;
  }

  /** Barge-in: cut off whatever is playing. */
  stop(): void {
    this.token++;
    this.abort?.abort();
    if (this.audio) {
      this.audio.pause();
      this.cleanup();
    }
    if (this.supportsBrowserSpeech) window.speechSynthesis.cancel();
    this.o.onState({ speaking: false, engine: "none" });
  }
}
