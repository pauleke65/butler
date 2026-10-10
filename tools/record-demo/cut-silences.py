"""Shorten long pauses in a recorded take (jump cuts while the cloud works) and trim the tail.

    python3 cut-silences.py in.mp4 out.mp4 [--max 3.2] [--keep 1.0] [--tail 3.0]

Silences longer than --max seconds keep --keep seconds on each side; everything after the last speech + --tail goes.
"""
import re
import subprocess
import sys

args = sys.argv[1:]
src, dst = args[0], args[1]
opt = lambda k, d: float(args[args.index(k) + 1]) if k in args else d
MAX, KEEP, TAIL = opt("--max", 3.2), opt("--keep", 1.0), opt("--tail", 3.0)

dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]).decode())
log = subprocess.run(["ffmpeg", "-hide_banner", "-i", src, "-af", "silencedetect=noise=-38dB:d=1.5", "-f", "null", "-"], capture_output=True, text=True).stderr
starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", log)]
ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", log)]
silences = list(zip(starts, ends + [dur] * (len(starts) - len(ends))))
end = dur
cuts = []
for a, b in silences:
    if b >= dur - 0.05:  # trailing silence: trim the tail
        end = min(dur, a + TAIL)
    elif b - a > MAX:
        cuts.append((a + KEEP, b - KEEP))
keep, t = [], 0.0
for a, b in cuts:
    keep.append((t, a))
    t = b
keep.append((t, end))
parts, labels = [], ""
for i, (a, b) in enumerate(keep):
    parts.append(f"[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}];[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS[a{i}]")
    labels += f"[v{i}][a{i}]"
fc = ";".join(parts) + ";" + labels + f"concat=n={len(keep)}:v=1:a=1[v][a]"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-c:v", "libx264",
                "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", dst], check=True)
print(f"cut {len(cuts)} pauses: {[(round(a, 1), round(b, 1)) for a, b in cuts]}; {dur:.1f}s -> {sum(b - a for a, b in keep):.1f}s")
