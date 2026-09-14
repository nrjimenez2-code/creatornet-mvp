jest.mock("@/lib/discoverServer", () => ({ discoverEnabled: () => false }));
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/siteUrl", () => ({
  getSiteUrl: () => "https://creatornet.test",
}));
import { attributedBookingUrl } from "@/lib/discoverBookings";

const initialSchedulingOrigin = process.env.SCHEDULING_OAUTH_ORIGIN;
afterEach(() => {
  if (initialSchedulingOrigin === undefined) delete process.env.SCHEDULING_OAUTH_ORIGIN;
  else process.env.SCHEDULING_OAUTH_ORIGIN = initialSchedulingOrigin;
});

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

test("verified intent reaches the native Google booking route",()=>{const id="11111111-1111-4111-8111-111111111111";expect(new URL(attributedBookingUrl('/scheduling/book/'+id,id)).searchParams.get('cn_attribution')).toBe(id);});

test("checkout preserves Google attribution on the configured scheduling origin", () => {
  process.env.SCHEDULING_OAUTH_ORIGIN = "https://staging.creatornet.test";
  const id = "11111111-1111-4111-8111-111111111111";
  const booking = `https://staging.creatornet.test/scheduling/book/${id}?source=video`;
  const result = new URL(attributedBookingUrl(booking, id));
  expect(result.searchParams.get("cn_attribution")).toBe(id);
  expect(result.searchParams.get("source")).toBe("video");
  for (const raw of [
    `https://other.test/scheduling/book/${id}`,
    `https://staging.creatornet.test.evil.test/scheduling/book/${id}`,
    `https://user@staging.creatornet.test/scheduling/book/${id}`,
    "https://staging.creatornet.test/api/book",
    "https://staging.creatornet.test/scheduling/book/not-a-connection",
  ]) expect(attributedBookingUrl(raw, id)).toBe(raw);
});

test.each([undefined, "http://staging.creatornet.test", "https://staging.creatornet.test/wrong-path"])(
  "missing or invalid scheduling configuration does not break existing booking links (%s)",
  (configured) => {
    if (configured === undefined) delete process.env.SCHEDULING_OAUTH_ORIGIN;
    else process.env.SCHEDULING_OAUTH_ORIGIN = configured;
    const id = "11111111-1111-4111-8111-111111111111";
    const raw = `https://staging.creatornet.test/scheduling/book/${id}`;
    expect(attributedBookingUrl(raw, id)).toBe(raw);
    expect(new URL(attributedBookingUrl("https://cal.com/creator/call", id)).searchParams.get("metadata[cn_attribution]")).toBe(id);
  },
);
