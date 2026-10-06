import { describe, expect, it } from "vitest";
import { looksLikeCarousel } from "./use-simulator";

describe("looksLikeCarousel", () => {
  it("uses the URI first", () => {
    expect(looksLikeCarousel("ui://butler/options", {})).toBe(true);
    expect(looksLikeCarousel("ui://butler/actions", {})).toBe(true);
    expect(looksLikeCarousel("ui://butler/plan", { needs: [{ title: "a" }, { title: "b" }, { title: "c" }] })).toBe(false);
  });
  it("falls back to 3-5 titled items in the data", () => {
    const sc = { pending_decisions: [{ options: [{ title: "a" }, { title: "b" }, { title: "c" }] }] };
    expect(looksLikeCarousel("ui://x/view", sc)).toBe(true);
    expect(looksLikeCarousel("ui://x/view", { items: [{ title: "a" }, { title: "b" }] })).toBe(false);
    expect(looksLikeCarousel(undefined, { items: [{ foo: 1 }, { foo: 2 }, { foo: 3 }] })).toBe(false);
  });
});
