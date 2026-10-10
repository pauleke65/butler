"""Cut one voice note into the walkthrough's numbered clips (01.wav ... 21.wav) for `record.mjs --voice-dir`.

    python3 split-voicenote.py voicenote.m4a voice/ [--script walkthrough-script.json] [--gap 1.2] [--floor -35]

Speech is separated at pauses of at least --gap seconds (quieter than --floor dB). The audio is cleaned first
(high-pass, gentle noise reduction, loudness normalised to podcast level). If the number of takes does not match the
script (a re-read line, a cough), it prints the takes with their lengths and writes nothing, so they can be matched up.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
if len(args) < 2:
    sys.exit(__doc__)
src, out = Path(args[0]), Path(args[1])
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
script = json.loads(Path(opt("--script", Path(__file__).with_name("walkthrough-script.json"))).read_text())
GAP, FLOOR = float(opt("--gap", "1.2")), float(opt("--floor", "-35"))
PAD_IN, PAD_OUT, MIN_TAKE = 0.12, 0.22, 0.35

out.mkdir(parents=True, exist_ok=True)
clean = out / "_clean.wav"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", "44100",
                "-af", "highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11", str(clean)], check=True)
dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(clean)]))
log = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(clean), "-af", f"silencedetect=noise={FLOOR}dB:d={GAP}", "-f", "null", "-"],
                     capture_output=True, text=True).stderr
starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", log)]
ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", log)]

# speech = the spans between silences
takes, t = [], 0.0
for a, b in zip(starts, ends + [dur] * (len(starts) - len(ends))):
    if a - t >= MIN_TAKE:
        takes.append((t, a))
    t = b
if dur - t >= MIN_TAKE:
    takes.append((t, dur))

print(f"{len(takes)} takes found, script has {len(script)} clips")
if len(takes) != len(script):
    for i, (a, b) in enumerate(takes, 1):
        print(f"  take {i:2d}: {a:6.1f}s - {b:6.1f}s  ({b - a:4.1f}s)")
    sys.exit("take count does not match: nothing written (re-run with --gap/--floor, or match the takes by hand)")

for clip, (a, b) in zip(script, takes):
    a, b = max(0.0, a - PAD_IN), min(dur, b + PAD_OUT)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(clean), "-ss", f"{a:.3f}", "-to", f"{b:.3f}",
                    "-af", "afade=t=in:d=0.03,areverse,afade=t=in:d=0.06,areverse", str(out / f"{clip['id']}.wav")], check=True)
    print(f"  {clip['id']}  {b - a:4.1f}s  {clip['text'][:60]}")
clean.unlink()
