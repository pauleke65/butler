/** Push-to-talk speech recognition on top of the Web Speech API (Chrome/Edge/Safari). */

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type Ctor = new () => RecognitionLike;

function ctor(): Ctor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function sttSupported(): boolean {
  return !!ctor();
}

export interface PttOptions {
  lang?: string;
  onInterim(text: string): void;
  /** Called once per press with the final transcript (may be empty if nothing was heard). */
  onFinal(text: string): void;
  onListening(listening: boolean): void;
  onError(message: string): void;
}

export class PushToTalk {
  private rec?: RecognitionLike;
  private transcript = "";
  private active = false;

  constructor(private readonly opts: PttOptions) {}

  get listening(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    const C = ctor();
    if (!C) {
      this.opts.onError("Speech recognition is not supported in this browser. Use the text box, or open in Chrome.");
      return;
    }
    const rec = new C();
    rec.lang = this.opts.lang ?? "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    this.transcript = "";
    rec.onresult = (e) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.transcript = finalText || interim;
      this.opts.onInterim((finalText + interim).trim());
    };
    rec.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") this.opts.onError(`Speech recognition error: ${e.error}`);
    };
    rec.onend = () => {
      const text = this.transcript.trim();
      this.active = false;
      this.rec = undefined;
      this.opts.onListening(false);
      this.opts.onFinal(text);
    };
    this.rec = rec;
    this.active = true;
    this.opts.onListening(true);
    try {
      rec.start();
    } catch (err) {
      this.active = false;
      this.opts.onListening(false);
      this.opts.onError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Release the key: stop and deliver the transcript. */
  stop(): void {
    this.rec?.stop();
  }

  abort(): void {
    if (!this.rec) return;
    this.rec.onend = null;
    this.rec.abort();
    this.rec = undefined;
    this.active = false;
    this.opts.onListening(false);
  }
}
