import { interpretSearch, normalizeSearchText } from "@/lib/searchQuery";

describe("search interpretation", () => {
  it.each(["ecom", "E-Commerce", "e commerce", "ecommerce"])("normalizes %s", input => {
    expect(interpretSearch(input).normalized).toBe("ecommerce");
  });
  it("preserves a user's more specific intent", () => {
    expect(interpretSearch("e-commerce coaching").normalized).toBe("ecommerce coaching");
    expect(interpretSearch("e-commerce coaching").related).toContain("dropshipping coaching");
    expect(interpretSearch("e-commerce coaching").related).not.toContain("dropshipping");
  });
  it("keeps related topics separate from equivalent terms", () => {
    expect(interpretSearch("ecom").related).toContain("dropshipping");
    expect(interpretSearch("dropshipping").normalized).toBe("dropshipping");
  });
  it("handles hashtags, unicode and punctuation without query syntax", () => {
    expect(interpretSearch("#Ecommerce")).toMatchObject({ normalized: "ecommerce", isTagSearch: true });
    expect(normalizeSearchText("ＣＯＡＣＨ / café %_*")).toBe("coach café");
  });
  it.each([null, 1, {}, [], "x".repeat(161)])("rejects invalid input %p", input => {
    expect(() => interpretSearch(input)).toThrow();
  });
});
