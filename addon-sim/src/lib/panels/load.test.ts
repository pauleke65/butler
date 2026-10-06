import { describe, expect, it } from "vitest";
import { panelsFromModule } from "./load";

const p = (id: string) => ({ id, title: id, mount: () => undefined });

describe("panelsFromModule", () => {
  it("accepts default, named and array exports and de-duplicates by id", () => {
    const a = p("a");
    expect(panelsFromModule({ default: a, panel: a })).toEqual([a]);
    expect(panelsFromModule({ panels: [p("x"), p("y")] }).map((x) => x.id)).toEqual(["x", "y"]);
    expect(panelsFromModule({ default: { id: 1 } })).toEqual([]);
    expect(panelsFromModule({})).toEqual([]);
  });
});
