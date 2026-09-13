jest.mock("@/lib/discoverServer", () => ({ discoverEnabled: () => false }));
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/siteUrl", () => ({
  getSiteUrl: () => "https://creatornet.test",
}));
import { attributedBookingUrl } from "@/lib/discoverBookings";

test("opaque attribution survives both providers and the internal booking router", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(
    new URL(
      attributedBookingUrl("https://cal.com/creator/call?layout=month", id),
    ).searchParams.get("metadata[cn_attribution]"),
  ).toBe(id);
  expect(
    new URL(
      attributedBookingUrl("https://calendly.com/creator/call", id),
    ).searchParams.get("utm_content"),
  ).toBe("cn_" + id);
  expect(
    new URL(
      attributedBookingUrl("/api/book?creator_id=creator", id),
    ).searchParams.get("cn_attribution"),
  ).toBe(id);
  expect(attributedBookingUrl("https://other.test/call", id)).toBe(
    "https://other.test/call",
  );
  expect(attributedBookingUrl("https://cal.com/creator/call", null)).toBe(
    "https://cal.com/creator/call",
  );
});
