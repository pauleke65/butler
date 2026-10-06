# Devpost: Open Source mini challenge (draft)

Fields for the Open Source entry. Paul to review before pasting. Items in `<angle brackets>` are placeholders.

| Field | Value |
|---|---|
| Contribution URL | `<https://github.com/OWNER/addon-sim>` (the simulator repo; or the specific PR/release `v0.1.0` if the form wants a single contribution) |
| Project repo URL | `<https://github.com/OWNER/butler>` |
| GitHub username | `<github-username>` |
| Licence | MIT (visible in the repo's About box) |

## What I did

I built and open-sourced **addon-sim**, a generic simulator for voice assistants that host MCP add-ons. Alexa+ can now call third-party tools over the Model Context Protocol, but the official web simulator is gated, so most builders have no way to see how their add-on behaves on a real device screen. addon-sim fills that gap: you point it at any MCP server and it plays the assistant. It routes spoken utterances to tools, calls them over Streamable HTTP, renders MCP Apps views on 1280x800 and 1920x1080 smart-display frames or stays voice-only on a speaker, speaks replies with Amazon Polly, handles elicitation, and records every call in an inspector.

It is not specific to my project. Butler, my entry, is just one add-on that plugs into it through a separate panel plugin; the simulator itself has no Butler code.

## How it works

* **Next.js 16 + Tailwind app** with a server-side MCP client (official TypeScript SDK) that declares form and URL elicitation and the MCP Apps UI extension, supports bearer and OAuth2 client-credentials auth, and shows the negotiated protocol version.
* **A real MCP Apps host.** Views run in a sandbox-proxy iframe served from a second origin (`:3001`) with the CSP derived from the view's `_meta.ui.csp`, wired up with `AppBridge` from `@modelcontextprotocol/ext-apps`: tool input then tool result, view-initiated `tools/call` forwarded to the right server, inline and fullscreen display modes, teardown on replacement, and a generic fallback card for results without a UI.
* **A pluggable "assistant brain".** One `Brain` interface with two implementations: a deterministic keyword router (offline, for CI and rehearsals) and an Amazon Bedrock Converse tool-use loop (Claude Haiku 4.5) that picks tools from names and descriptions only. Conversation memory, "yes" bound to the last pending confirmation, clarification on ambiguous references.
* **Voice.** Push-to-talk with the Web Speech API, Amazon Polly neural voices with automatic fallback to the browser's speech synthesis, barge-in, captions.
* **Developer tooling.** An inspector (arguments, results, TTFB and total time, first-render time with a warning when a carousel takes longer than 500 ms, JSON export), a panel plugin API loaded by URL, and a YAML scripted-conversation runner (`pnpm run-script`) that runs headless in CI or in the UI for rehearsals. Everything is covered by unit and integration tests that need no network or AWS.

## Why it matters

Every Alexa+ builder hits the same wall: you cannot iterate on an add-on's tool descriptions, views and latency without access to a gated tool. addon-sim removes it for anyone with a laptop. It also encodes the practical rules from the Alexa+ design guidance (inline by default, far-field type sizes, a 500 ms first-item budget for carousels) as things you can see and measure, and the scripted runner turns a demo into a regression test. Because it speaks plain MCP and MCP Apps, it is useful beyond Alexa+ to anyone building an add-on for an assistant that hosts MCP servers.

Not affiliated with Amazon. Device frames are generic and carry no Amazon branding.

## Links to include on the form

* Repo: `<https://github.com/OWNER/addon-sim>`
* Quick start: README section "Quick start (about 10 minutes)"
* Demo of the simulator inside the Butler video: `<YouTube URL>`
