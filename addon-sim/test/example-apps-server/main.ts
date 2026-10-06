import { createExampleServer } from "./server";
import { serveMcp } from "../support/http";

const port = Number(process.env.EXAMPLE_APPS_PORT ?? 8120);
const state = { count: 0 };
const served = await serveMcp(() => createExampleServer(state), { port, stateful: true });
console.log(`example MCP Apps server: ${served.url} (no auth)`);
