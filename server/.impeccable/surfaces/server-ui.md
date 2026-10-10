---
version: 1
slug: "server-ui"
primary_target: "server/ui"
related_targets: ["addon-sim/src/components","sim-panel/src"]
---

# Butler on Alexa+: screens, simulator shell, Black Box

Mode: Operate (the customer is mid-task; the judge watches a demo). Build path: code-led (no image generation).

## Direction contract

THESIS: Butler should be indistinguishable from a first-party Alexa+ experience. The receipt and the gateway DENY are the only things that are Butler's own. It refuses the developer-dashboard look: bordered boxes, uppercase badges and a black canvas.

OWN-WORLD:
- Canon is Amazon's Alexa+ MCP design guide.
- Surfaces: Alexa navy canvas #173055; cards #0E1C30 with #132641 inner tiles; Echo bezel #14181E.
- Alexa blue #408EFF for the reply bubble and the pill CTAs, which carry a dark arrow badge.
- Type: Figtree at weight 400 on the guide's 768-unit canvas scale; large and light.
- Radii are 16 base units. Status is soft tinted pills, and red is reserved for DENY.

STORY: The customer hears the reply, glances at the card, and taps one pill. The judge sees a real-looking Echo Show, and beside it a quiet Black Box that turns red when the gateway says no.

FIRST VIEWPORT:
- Inside the Echo Show frame: the topic at top-left and the page dots on the left edge.
- Alexa's blue reply bubble fills the left 28%, and Butler's card the right 60%.
- A cyan light bar runs along the bottom edge while listening.
- To the right of the device: the slim Black Box card. Below it: the transcript bar, then the inspector column.

FORM: Echo Show conversation layout (guide's Card/List/Carousel), ordered list position 1, seed key: user-pinned canon (no generated seed).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
