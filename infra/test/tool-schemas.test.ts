import { describe, expect, it } from "vitest";
import {
  GATEWAY_TOOL_NAMES,
  OPTIONAL_POLICY_FIELDS,
  POLICY_FIELDS,
  TOOL_DESCRIPTIONS,
  loadContractSchema,
  splitTool,
  toolDefinition,
  toolsByTarget,
} from "../lib/tool-schemas";

type Def = ReturnType<typeof toolDefinition>;
const props = (d: Def) => (d.inputSchema.properties ?? {}) as Record<string, { type: { value: string }; items?: { type: { value: string } }; description?: string }>;

describe("gateway tool schemas (generated from the contracts)", () => {
  it("covers every contract tool exactly once, grouped into the five targets", () => {
    const grouped = toolsByTarget();
    expect(Object.keys(grouped).sort()).toEqual(["Calendar", "Context", "Messages", "Services", "Supplies"]);
    const names = Object.entries(grouped).flatMap(([t, defs]) => defs.map((d) => `${t}___${d.name}`));
    expect(names.sort()).toEqual([...GATEWAY_TOOL_NAMES].sort());
    expect(names).toHaveLength(12);
  });

  it("uses the contract descriptions", () => {
    for (const tool of GATEWAY_TOOL_NAMES) expect(toolDefinition(tool).description).toBe(TOOL_DESCRIPTIONS[tool]);
  });

  it("carries exactly the fields the wrapper sends: contract inputs incl. idempotency_key/correlation_id, never reasoning", () => {
    const defs = loadContractSchema().$defs;
    for (const tool of GATEWAY_TOOL_NAMES) {
      const d = toolDefinition(tool);
      expect(Object.keys(props(d))).not.toContain("reasoning");
      expect(d.inputSchema.required).toEqual(expect.arrayContaining(["idempotency_key", "correlation_id"]));
      for (const k of ["plan_id", "need_id", "idempotency_key", "correlation_id"]) expect(Object.keys(props(d))).toContain(k);
      // property set == the contract's
      const contract = Object.keys((defs[(tool.split("___")[1]!.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") + "Input")] ?? { properties: {} }).properties ?? {});
      expect(Object.keys(props(d)).sort()).toEqual(contract.sort());
    }
  });

  it.each(Object.entries(POLICY_FIELDS))("policy field %s is required and typed exactly on the tools Cedar reads it on", (field, spec) => {
    for (const tool of spec.tools) {
      const d = toolDefinition(tool);
      expect(d.inputSchema.required, `${tool}.${field} required`).toContain(field);
      expect(props(d)[field]!.type.value, `${tool}.${field} type`).toBe(spec.type);
    }
  });

  it.each(Object.entries(OPTIONAL_POLICY_FIELDS))("recipient field %s is typed exactly (optional by contract)", (field, spec) => {
    const d = toolDefinition("Messages___send_email");
    expect(props(d)[field]!.type.value).toBe(spec.type);
    if (spec.type === "array") expect(props(d)[field]!.items!.type.value).toBe("string");
    expect(d.inputSchema.required).not.toContain(field);
  });

  it("amount_minor is an integer on checkout and book_service; category is a string; event_owner a string", () => {
    expect(props(toolDefinition("Supplies___checkout"))["amount_minor"]!.type.value).toBe("integer");
    expect(props(toolDefinition("Services___book_service"))["amount_minor"]!.type.value).toBe("integer");
    expect(props(toolDefinition("Supplies___checkout"))["category"]!.description).toMatch(/groceries, drinks/);
  });

  it("splitTool rejects names that are not Target___tool", () => {
    expect(splitTool("Supplies___checkout")).toEqual({ target: "Supplies", name: "checkout" });
    expect(() => splitTool("checkout")).toThrow();
    expect(() => splitTool("Bogus___x")).toThrow();
  });
});
