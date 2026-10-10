# Publishing addon-sim as its own repo (Open Source mini challenge)

The simulator lives in `addon-sim/` and is exported, with its history, to the local branch `addon-sim-export`:

```bash
git subtree split --prefix addon-sim -b addon-sim-export   # refresh after any change to addon-sim/
```

A fresh clone of that branch installs, type-checks and passes its tests on its own (checked 2026-10-10).

To publish (Paul, or ask Claude to run it once the GitHub repo exists):

1. Create an empty public GitHub repo, e.g. `addon-sim`, with no README or licence (the branch has both).
2. Push the branch as `main`:
   ```bash
   git push https://github.com/pauleke65/addon-sim.git addon-sim-export:main
   ```
3. In the repo's About box, confirm GitHub detects the MIT licence; add topics `mcp`, `mcp-apps`, `alexa`, `simulator`.
4. Tag a release `v0.1.0`.
5. Put the URL into `addon-sim/docs/devpost-open-source.md` and `docs/devpost.md`.
