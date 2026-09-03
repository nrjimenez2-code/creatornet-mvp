/**
 * The Privacy Policy and Terms must name the registered legal entity and its
 * mailing address — Stripe's website review and the policies themselves both
 * point a reader at "who we are". Until 2026-09-03 both pages said "operated by
 * the CreatorNet team" with a TODO(Noah) comment in place of the facts.
 *
 * Renders the real page components (server components returning JSX) with
 * react-dom/server and asserts on the visible markup, not the source text.
 * Section 8 of the Terms (governing law / venue) is still pending from the
 * founder and must NOT have changed. Mutation-checked.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const ENTITY = "CreatorNet LLC";
const STREET = "21095 North 64th Avenue";
const CITY = "Glendale, AZ 85308";
/** The mailing address exactly as it must render, line by line. */
const ADDRESS_BLOCK = `<address class="not-italic">${ENTITY}<br/>${STREET}<br/>${CITY}<br/>United States</address>`;

async function render(route: "privacy" | "terms"): Promise<string> {
  const mod = await import(`@/app/legal/${route}/page`);
  return renderToStaticMarkup(createElement(mod.default));
}

describe("legal pages name the registered entity and mailing address", () => {
  it.each(["privacy", "terms"] as const)("/legal/%s names CreatorNet LLC and its address", async (route) => {
    const html = await render(route);
    expect(html).toContain(ENTITY);
    expect(html).toContain(STREET);
    expect(html).toContain(CITY);
    expect(html).toContain(ADDRESS_BLOCK);
  });

  it.each(["privacy", "terms"] as const)("/legal/%s no longer names 'the CreatorNet team' as the operator", async (route) => {
    const html = await render(route);
    expect(html).not.toContain("CreatorNet team");
    expect(html).toContain(`operated by ${ENTITY}`);
  });

  it("terms section 8 (governing law / venue) is unchanged and still pending", async () => {
    const html = await render("terms");
    expect(html).toContain("Where a governing-law and venue designation is required");
  });
});
