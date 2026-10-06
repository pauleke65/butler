import { newMockState, createMockButler } from "./butler-mock";
import { serveMcp } from "../support/http";

const port = Number(process.env.MOCK_BUTLER_PORT ?? 8110);
const token = process.env.MOCK_BUTLER_TOKEN ?? "local-sim-token";
const state = newMockState();
const served = await serveMcp(() => createMockButler(state), { port, token: token || undefined, log: (l) => process.env.VERBOSE && console.log(l) });
console.log(`mock Butler MCP server: ${served.url} (bearer ${token || "none"})`);
