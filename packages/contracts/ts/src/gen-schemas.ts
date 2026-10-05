import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registry } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../schemas");
mkdirSync(out, { recursive: true });

// One combined document with every named schema as a $def, refs between them preserved.
const json = z.toJSONSchema(registry, {
  uri: (id) => `#/$defs/${id}`,
  io: "input",
  unrepresentable: "any",
}) as { schemas: Record<string, unknown> };

const defs: Record<string, unknown> = {};
for (const [id, schema] of Object.entries(json.schemas)) {
  const { $schema: _s, ...rest } = schema as Record<string, unknown>;
  defs[id] = rest;
}
const doc = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ButlerContracts",
  type: "object",
  properties: Object.fromEntries(Object.keys(defs).map((k) => [k, { $ref: `#/$defs/${k}` }])),
  $defs: defs,
};
writeFileSync(resolve(out, "butler.schema.json"), JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${Object.keys(defs).length} schemas`);
