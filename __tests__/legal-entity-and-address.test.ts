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

  it.each(["privacy", "terms"] as const)("/legal/%s shows the new 'Last updated' date", async (route) => {
    const html = await render(route);
    expect(html).toContain("Last updated: September 3, 2026");
  });

  it("terms places the address under '10. Contact', privacy under 'Who we are'", async () => {
    const terms = await render("terms");
    expect(terms.indexOf(ADDRESS_BLOCK)).toBeGreaterThan(terms.indexOf("10. Contact"));
    const privacy = await render("privacy");
    const whoWeAre = privacy.indexOf("Who we are");
    const nextSection = privacy.indexOf("What we collect");
    const at = privacy.indexOf(ADDRESS_BLOCK);
    expect(at).toBeGreaterThan(whoWeAre);
    expect(at).toBeLessThan(nextSection);
  });

  it("terms section 8 (governing law / venue) is byte-for-byte what it was — still pending from Noah", async () => {
    const html = await render("terms");
    // Everything between the section-8 heading and the section-9 heading, as
    // visible text. Any rewording — not just the one sentence — fails here.
    const start = html.indexOf("8. Disputes");
    const end = html.indexOf("9. Changes");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const text = html
      .slice(start, end)
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;|&apos;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    expect(text).toBe(
      "8. Disputes If something goes wrong, contact support@creatornet.net first — most issues can " +
        "be resolved informally. Where a governing-law and venue designation is required, it will be " +
        "added to these Terms as CreatorNet's legal setup is finalized and flagged as a material change."
    );
    // And the support link is a real mailto, not a dead anchor.
    expect(html.slice(start, end)).toContain('href="mailto:support@creatornet.net"');
  });

  it("terms '10. Contact' keeps a real mailto link above the address", async () => {
    const html = await render("terms");
    const contact = html.slice(html.indexOf("10. Contact"));
    expect(contact).toContain('href="mailto:support@creatornet.net"');
    expect(contact.indexOf('href="mailto:support@creatornet.net"')).toBeLessThan(contact.indexOf(ADDRESS_BLOCK));
  });
});
