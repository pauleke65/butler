# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Household member on Alexa+.** Talks to an Echo Show (8 or 15) from across a kitchen or living room, mid-task. They describe what is happening ("six friends are coming Friday at 7") and expect it handled. They glance at the screen and only sometimes touch it.
- **Hackathon judges.** They see Butler mostly through a sub-3-minute demo video and the repository. They decide in seconds whether it looks like a real Alexa+ add-on or a prototype.
- **Alexa+ add-on developers.** They use addon-sim, the open-source simulator, to run any MCP server on a simulated smart display, with a transcript and an inspector.

## Product Purpose

Butler is an Alexa+ add-on (an MCP server with MCP Apps screens).

- You describe a situation; Butler works out what it needs, does what it is allowed to, and asks only about the rest.
- Every action leaves a receipt: what it did, why, what it rejected, and which rule allowed or stopped it.
- A correction ("don't buy drinks without asking me") becomes a Cedar rule. AgentCore Policy enforces it at the AgentCore Gateway, outside the model.

Success means the customer trusts what Butler did without having to watch it do it.

## Positioning

Butler's limits are enforced by the gateway, not promised by the model. A denied purchase is a real gateway DENY with a receipt, and the AI cannot approve its own held actions. Approvals run under a separate identity, the approval executor.

## Operating Context

- **Screens.** MCP Apps views (`ui://butler/plan|options|receipt|actions|rule|rules`) render inside the Alexa+ host on Echo Show 8 (1280×800) and Echo Show 15 (1920×1080), inline or fullscreen. They follow Amazon's Alexa+ MCP design guide: far-field type, List, Carousel and Card layouts, touch targets of 48 px or more, light and dark themes.
- **Voice.** Each tool also returns a voice-only `spoken_summary`, and the host speaks it. The screen supports the voice; it never carries the only copy of the information.
- **Demo.** The demo runs in addon-sim, with the Butler "Black Box" panel (a sim-panel plugin) live-tailing gateway decisions next to the device.

## Capabilities and Constraints

- **Turn-based.** Alexa+ cannot push notifications to the add-on. Pending decisions surface the next time the customer asks.
- **Size and format.** Each view is a single self-contained HTML file under 200 KB, with no external network fetches. Fonts and icons are inlined.
- **Simulated providers.** Suppliers and cleaners are simulated and must be labelled "Simulated". Nothing real is bought or booked.
- **Money.** Amounts are integer minor units plus an ISO currency.

## Brand Commitments

- **Visual language (user-pinned, 2026-10-10).** Butler's screens and the simulator shell must look native to Alexa+, per Amazon's public Alexa+ MCP design guide. The user rejected the previous look as "AI slop".
- **Name.** Butler. Its voice is plain, brief and concrete: numbers spoken as words, no jargon.

## Evidence on Hand

- **Golden demo.** 13 steps, `addon-sim/scripts/butler-golden.yaml`, passing locally and on AWS dev.
- **Live AWS stack (dev).** Real AgentCore Gateway DENY receipts, with `gateway_request_id`.
- **Demo videos.** `docs/demo/*.mp4`, git-ignored.
- **Not on hand: user research, customer quotes, production usage.** Do not invent them.

## Product Principles

1. **Show the receipt, not the reasoning theatre.** Every action is inspectable after the fact.
2. **Ask only when it should.** One question at a time, at the moment the customer asks.
3. **Enforcement lives outside the model.** The UI never implies the AI decided its own limits.
4. **Glanceable from across the room.** The screen supports a voice conversation.

## Accessibility & Inclusion

- Contrast at least 4.5:1, or 3:1 for text that is large (18 px or more) or bold.
- Status is never shown by colour alone: every chip carries a text label.
- Touch targets are at least 48 px.
- The views honour `prefers-reduced-motion`.
