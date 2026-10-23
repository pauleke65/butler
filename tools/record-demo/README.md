# record-demo

Records the Butler golden demo from the simulator as a captioned, narrated mp4 (`docs/demo/butler-demo.mp4`, git-ignored). Your lines and Butler's replies are spoken with local macOS voices (`say`), so no cloud calls; `--silent` skips narration.

```bash
scripts/stack.sh start
(cd sim-panel && pnpm build && pnpm serve &)
(cd addon-sim && PANEL_URLS=http://localhost:3002/panel.js DEBUG_API_URL=http://localhost:8085 DEBUG_API_TOKEN=local-debug-token pnpm dev &)
cd tools/record-demo && pnpm install --ignore-workspace && node record.mjs
```

Needs macOS (`say`), Microsoft Edge or Chrome (set `BROWSER_PATH` to use another) and `ffmpeg`.

Pin the clock so the narration says "Friday" and "Thursday to Sunday" whatever day you record:

```bash
export BUTLER_NOW=2026-10-12T10:00:00-04:00   # a Monday morning
scripts/stack.sh restart && uv run python -m butler_local.seed --reset
```

Voices: `VOICE_YOU` (default "Reed (English (US))"), `VOICE_BUTLER` ("Samantha"), `VOICE_NARRATOR` ("Daniel"). The take must stay under 3:00 (the last one was 2:40).

## Amazon Polly voices (recommended for the submission)

```bash
AWS_PROFILE=pie TTS=polly node record.mjs --prewarm lines.json --out ../../docs/demo/butler-demo-polly.mp4
```

- Voices: Ruth (Butler) and Matthew (you), both Polly *generative*; Gregory (*long-form*) narrates. A take costs a few cents.
- `--prewarm lines.json` renders every known line first and caches it in `.tts-cache/`, so a flaky network can't leave gaps.
- Frames are taken as screenshots on a steady clock (`CAPTURE_FPS`, default 12). The DevTools screencast drifted ~5 s behind the audio in long takes; `CAPTURE=screencast` keeps it available.
- The simulator's own voice is switched off during recording (it delayed typing while "speaking").

## Submission walkthrough (presenter voice, live AWS stack)

The Devpost video. One presenter voice (Polly *Stephen*) narrates in the first person and talks to the Echo, Butler answers (Ruth). There are no chapter banners; the browser itself zooms like a camera onto the device and the Black Box. It runs against the deployed `dev` stack, so the DENY in the video is a real AgentCore Gateway decision.

```bash
export AWS_PROFILE=pie AWS_REGION=us-east-1 PYTHONPATH=$PWD/tools/record-demo/pydns   # pydns: DNS fallback for flaky home routers
BUTLER_NOW=2026-10-12T10:00:00-04:00 uv run python infra/scripts/seed_aws.py --stage dev --reset   # also deletes rule policies earlier takes created
tools/record-demo/sim-aws.sh                      # simulator against AgentCore Runtime + the deployed debug API (1 h token)
cd tools/record-demo
TTS=polly node record.mjs --mode walkthrough --prewarm walkthrough-lines.json --out ../../docs/demo/butler-walkthrough-raw.mp4
python3 cut-silences.py ../../docs/demo/butler-walkthrough-raw.mp4 ../../docs/demo/butler-walkthrough.mp4   # trims cloud waits
```

- The take waits for the cloud: the agent's purchases must land before "How's Friday looking?", and the new rule must be active in AgentCore before the travel step.
- `cut-silences.py` shortens pauses longer than 3.2 s (policy activation takes ~10 s) to about 2 s, and trims the tail.
- To land under 3:00 with your own voice, cut tighter and keep silent camera moves whole: `--max 2.2 --keep 0.75 --tail 2.5 --hold <t1>,<t2>` (times in the raw take). The submitted video used `--hold 205.5,215.3`.

### With your own voice

The presenter's 21 clips are in [`docs/demo/voiceover-script.md`](../../docs/demo/voiceover-script.md) (their text, ids and on-screen moments live in `walkthrough-script.json`). Record them in one voice note with two-second pauses, then:

```bash
python3 split-voicenote.py ~/Downloads/voicenote.m4a voice/      # cleans the audio, cuts it into voice/01.wav ... 21.wav
TTS=polly node record.mjs --mode walkthrough --voice-dir voice --prewarm walkthrough-lines.json --out ../../docs/demo/butler-walkthrough-raw.mp4
python3 cut-silences.py ../../docs/demo/butler-walkthrough-raw.mp4 ../../docs/demo/butler-walkthrough.mp4
```

Clips you recorded play in your voice; any missing clip falls back to Polly. If the splitter finds more or fewer takes than clips (a re-read line), it lists them with their lengths and writes nothing.

If your pauses were too short for the splitter, cut by transcript instead: transcribe the note with word timestamps (for example faster-whisper `word_timestamps=True`, saved as `[{"w", "s", "e"}, ...]`), then run `python3 align-voicenote.py words.json ~/Downloads/voicenote.m4a voice/`. It matches the words to the script's clips and cuts at the quietest point between them.
