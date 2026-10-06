/**
 * Gateway tool schemas, generated from the contracts (packages/contracts/schemas/butler.schema.json for the input
 * shapes, TOOL_DESCRIPTIONS / GATEWAY_TOOL_NAMES from packages/contracts/ts for names and descriptions).
 *
 * The CloudFormation `SchemaDefinition` only knows type / description / items / properties / required, so enum,
 * length and range constraints from the JSON Schema are carried in the property description instead. The fields
 * that Cedar policies read (amount_minor, category, event_owner, recipient_*) are `required` where the contracts
 * require them and typed exactly (integer / string / array of string); the action Lambdas re-validate them.
 *
 * `reasoning` is intentionally absent: butler_actions.wrapper strips it before the Gateway call. The wrapper adds
 * correlation_id / plan_id / need_id / idempotency_key, which the contract schemas already declare.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { GATEWAY_TOOL_NAMES, TOOL_DESCRIPTIONS } from "@butler/contracts";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { REPO_ROOT } from "./config";

export const SCHEMA_PATH = path.join(REPO_ROOT, "packages/contracts/schemas/butler.schema.json");

export const DELIMITER = "___";
export type ToolName = (typeof GATEWAY_TOOL_NAMES)[number];
export const TARGETS = ["Messages", "Calendar", "Supplies", "Services", "Context"] as const;
export type TargetName = (typeof TARGETS)[number];

/** `$defs` name of each tool's input (contracts section 7). */
export const INPUT_DEF: Record<ToolName, string> = {
  Messages___send_email: "SendEmailInput",
  Calendar___list_events: "ListEventsInput",
  Calendar___create_event: "CreateEventInput",
  Calendar___update_event: "UpdateEventInput",
  Calendar___delete_event: "DeleteEventInput",
  Supplies___search_products: "SearchProductsInput",
  Supplies___checkout: "CheckoutInput",
  Supplies___refund: "RefundInput",
  Services___search_providers: "SearchProvidersInput",
  Services___book_service: "BookServiceInput",
  Services___cancel_booking: "CancelBookingInput",
  Context___get_weather: "GetWeatherInput",
};

/** Fields Cedar reads (contracts section 7 "Policy-relevant fields"): never allowed to be optional/mistyped here. */
export const POLICY_FIELDS: Record<string, { tools: ToolName[]; type: "integer" | "string" | "array" }> = {
  amount_minor: { tools: ["Supplies___checkout", "Services___book_service"], type: "integer" },
  category: { tools: ["Supplies___checkout"], type: "string" },
  event_owner: { tools: ["Calendar___update_event", "Calendar___delete_event"], type: "string" },
};
/** Optional by contract, but typed exactly when present (the Cedar guards use `has`). */
export const OPTIONAL_POLICY_FIELDS: Record<string, { tools: ToolName[]; type: "string" | "array" }> = {
  recipient_email: { tools: ["Messages___send_email"], type: "string" },
  recipient_contact_ids: { tools: ["Messages___send_email"], type: "array" },
};

/** Field hints, keyed `Tool.field` (wins) or `field`. */
const FIELD_HINTS: Record<string, string> = {
  "Supplies___search_products.category": "Optional category filter.",
  amount_minor: "Total in minor units (cents) as an integer; must equal the exact total. Spend limits are checked on this field.",
  category: "Category of the items; must match the catalogue category of every item. Category rules are checked on this field.",
  event_owner: "Who created the event, from list_events (butler_owner). Rules that protect the customer's own events read this.",
  recipient_email: "A single address that is NOT a saved contact. Use recipient_contact_ids for saved contacts.",
  recipient_contact_ids: "Saved contact ids. Provide exactly one of recipient_contact_ids or recipient_email.",
  idempotency_key: "Stable key so a retried call does not repeat the side effect.",
  correlation_id: "Trace id for this customer request.",
};

interface JsonSchemaNode {
  type?: string;
  $ref?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  const?: unknown;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}
interface SchemaFile {
  $defs: Record<string, JsonSchemaNode>;
}

let cached: SchemaFile | undefined;
export function loadContractSchema(): SchemaFile {
  cached ??= JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as SchemaFile;
  return cached;
}

function resolve(node: JsonSchemaNode, defs: SchemaFile["$defs"]): JsonSchemaNode {
  if (!node.$ref) return node;
  const name = node.$ref.replace("#/$defs/", "");
  const target = defs[name];
  if (!target) throw new Error(`Unresolved $ref ${node.$ref} in ${SCHEMA_PATH}`);
  return resolve(target, defs);
}

function typeOf(t: string | undefined): agentcore.SchemaDefinitionType {
  switch (t) {
    case "string":
      return agentcore.SchemaDefinitionType.STRING;
    case "integer":
      return agentcore.SchemaDefinitionType.INTEGER;
    case "number":
      return agentcore.SchemaDefinitionType.NUMBER;
    case "boolean":
      return agentcore.SchemaDefinitionType.BOOLEAN;
    case "array":
      return agentcore.SchemaDefinitionType.ARRAY;
    case "object":
      return agentcore.SchemaDefinitionType.OBJECT;
    default:
      throw new Error(`Unsupported JSON Schema type "${String(t)}" in the contracts`);
  }
}

function constraintsText(node: JsonSchemaNode): string[] {
  const out: string[] = [];
  if (node.const !== undefined) out.push(`Must be ${JSON.stringify(node.const)}.`);
  if (node.enum) out.push(`One of: ${node.enum.map(String).join(", ")}.`);
  if (node.minimum !== undefined && node.maximum !== undefined && node.maximum < 1_000_000) out.push(`Between ${node.minimum} and ${node.maximum}.`);
  else if (node.minimum !== undefined) out.push(`At least ${node.minimum}.`);
  if (node.minItems !== undefined) out.push(`At least ${node.minItems} item(s).`);
  if (node.maxLength !== undefined) out.push(`At most ${node.maxLength} characters.`);
  return out;
}

function convert(node: JsonSchemaNode, defs: SchemaFile["$defs"], tool: string, hint?: string): agentcore.SchemaDefinition {
  const n = resolve(node, defs);
  const description = [hint, ...constraintsText(n)].filter(Boolean).join(" ") || undefined;
  const base = { type: typeOf(n.type), ...(description ? { description } : {}) };
  if (n.type === "array") {
    if (!n.items) throw new Error("array without items in contracts schema");
    return { ...base, items: convert(n.items, defs, tool) };
  }
  if (n.type === "object") {
    const properties: Record<string, agentcore.SchemaDefinition> = {};
    for (const [key, child] of Object.entries(n.properties ?? {})) properties[key] = convert(child, defs, tool, FIELD_HINTS[`${tool}.${key}`] ?? FIELD_HINTS[key]);
    return { ...base, properties, ...(n.required?.length ? { required: [...n.required] } : {}) };
  }
  return base;
}

export function splitTool(tool: string): { target: TargetName; name: string } {
  const [target, name] = tool.split(DELIMITER);
  if (!target || !name || !(TARGETS as readonly string[]).includes(target)) throw new Error(`Bad gateway tool name: ${tool}`);
  return { target: target as TargetName, name };
}

/** One inline tool definition (the Gateway adds the `<Target>___` prefix itself). */
export function toolDefinition(tool: ToolName): agentcore.ToolDefinition {
  const defs = loadContractSchema().$defs;
  const defName = INPUT_DEF[tool];
  const input = defs[defName];
  if (!input) throw new Error(`${defName} missing from ${SCHEMA_PATH}; run \`pnpm contracts:gen\``);
  return {
    name: splitTool(tool).name,
    description: TOOL_DESCRIPTIONS[tool],
    inputSchema: convert(input, defs, tool),
  };
}

/** Inline tool definitions grouped by Gateway target. */
export function toolsByTarget(): Record<TargetName, agentcore.ToolDefinition[]> {
  const out = Object.fromEntries(TARGETS.map((t) => [t, [] as agentcore.ToolDefinition[]])) as Record<TargetName, agentcore.ToolDefinition[]>;
  for (const tool of GATEWAY_TOOL_NAMES) out[splitTool(tool).target].push(toolDefinition(tool));
  return out;
}

export { GATEWAY_TOOL_NAMES, TOOL_DESCRIPTIONS };
