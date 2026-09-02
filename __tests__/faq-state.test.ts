import { nextOpenIndex } from "@/components/landing/faqState";

/** The FAQ's only rule: one answer open at a time; re-activating closes it. */
describe("nextOpenIndex", () => {
  it("opens a closed item", () => expect(nextOpenIndex(null, 2)).toBe(2));
  it("switches to a different item, closing the first", () => expect(nextOpenIndex(0, 3)).toBe(3));
  it("closes the item that is already open", () => expect(nextOpenIndex(1, 1)).toBeNull());
});
