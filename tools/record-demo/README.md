# record-demo

Records the Butler golden demo from the simulator as a silent, captioned mp4 (`docs/demo/butler-demo.mp4`, git-ignored).

```bash
scripts/stack.sh start
(cd sim-panel && pnpm build && pnpm serve &)
(cd addon-sim && PANEL_URLS=http://localhost:3002/panel.js DEBUG_API_URL=http://localhost:8085 DEBUG_API_TOKEN=local-debug-token pnpm dev &)
cd tools/record-demo && pnpm install --ignore-workspace && node record.mjs
```

Needs Microsoft Edge or Chrome (set `BROWSER_PATH` to use another) and `ffmpeg`. Voice is not captured; captions and the on-screen transcript carry the story. Add a voice-over when editing the final video.
