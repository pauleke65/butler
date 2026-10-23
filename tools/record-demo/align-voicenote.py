"""Cut a voice note into the walkthrough's clips by aligning a word-timed transcript to the script.

    python3 align-voicenote.py words.json voicenote.m4a voice/ [--script walkthrough-script.json]

words.json: [{"w": word, "s": start, "e": end}, ...] (e.g. from faster-whisper with word timestamps). Use this when
the pauses between lines are too short for split-voicenote.py. Each cut sits at the quietest point between the last word
of one clip and the first word of the next.
"""
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
words_file, src, out = Path(args[0]), Path(args[1]), Path(args[2])
script = json.loads(Path(args[args.index("--script") + 1] if "--script" in args else Path(__file__).with_name("walkthrough-script.json")).read_text())
words = json.loads(words_file.read_text())
norm = lambda t: re.sub(r"[^a-z0-9]", "", t.lower())

script_tokens, owner = [], []
for i, c in enumerate(script):
    for t in c["text"].split():
        if norm(t):
            script_tokens.append(norm(t))
            owner.append(i)
heard = [norm(w["w"]) for w in words]
mapping = {}
for tag, a0, a1, b0, b1 in difflib.SequenceMatcher(None, script_tokens, heard, autojunk=False).get_opcodes():
    if tag in ("equal", "replace"):
        for k in range(min(a1 - a0, b1 - b0)):
            mapping[a0 + k] = b0 + k
spans = []
for i in range(len(script)):
    idx = [mapping[k] for k, o in enumerate(owner) if o == i and k in mapping]
    if not idx:
        sys.exit(f"clip {script[i]['id']} not found in the transcript")
    spans.append((min(idx), max(idx)))

out.mkdir(parents=True, exist_ok=True)
clean = out / "_clean.wav"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", "44100",
                "-af", "highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11", str(clean)], check=True)
dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(clean)]))
pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(clean), "-ac", "1", "-ar", "1000", "-f", "s16le", "-"], capture_output=True).stdout
import array
env = array.array("h", pcm)  # 1 kHz samples, enough to find the quiet point in a gap

def quietest(a, b):
    lo, hi = int(a * 1000), max(int(a * 1000) + 1, int(b * 1000))
    seg = [abs(v) for v in env[lo:hi]]
    if not seg:
        return (a + b) / 2
    win = 40
    best, at = None, lo
    for i in range(0, max(1, len(seg) - win)):
        s = sum(seg[i:i + win])
        if best is None or s < best:
            best, at = s, lo + i + win // 2
    return at / 1000

cuts = []
for i in range(len(spans) - 1):
    a, b = words[spans[i][1]]["e"], words[spans[i + 1][0]]["s"]
    cuts.append(quietest(min(a, b), max(a, b) + 0.05))
bounds = [max(0.0, words[spans[0][0]]["s"] - 0.25)] + cuts + [min(dur, words[spans[-1][1]]["e"] + 0.4)]
for i, c in enumerate(script):
    # trim to the words (Whisper's word ends run early, so the tail gets more room), never past a neighbour's cut
    a = max(bounds[i], words[spans[i][0]]["s"] - 0.15)
    b = min(bounds[i + 1], words[spans[i][1]]["e"] + 0.35)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(clean), "-ss", f"{a:.3f}", "-to", f"{b:.3f}",
                    "-af", "afade=t=in:d=0.02,areverse,afade=t=in:d=0.05,areverse", str(out / f"{c['id']}.wav")], check=True)
    said = " ".join(w["w"] for w in words[spans[i][0]:spans[i][1] + 1])
    print(f"  {c['id']}  {a:6.2f}-{b:6.2f}  {said[:70]}")
clean.unlink()
