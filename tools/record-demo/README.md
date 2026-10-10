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
