import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
const rpc = jest.fn().mockResolvedValue({ error: null });
const single = jest
  .fn()
  .mockResolvedValue({
    data: { user_id: "viewer", creator_id: "creator" },
    error: null,
  });
const chain = { select: () => chain, eq: () => chain, single };
jest.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: () => chain,
    rpc: (...args: unknown[]) => rpc(...args),
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: { email: "viewer@example.test" } },
          error: null,
        }),
      },
    },
  },
}));
jest.mock("@/lib/discoverServer", () => ({ discoverEnabled: () => true }));
import { POST } from "@/app/api/scheduling/[connection]/route";
const id = "11111111-1111-4111-8111-111111111111";
function request(provider: string, body: unknown, signature = true) {
  const raw = JSON.stringify(body),
    t = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", "secret")
    .update(provider === "calendly" ? `${t}.${raw}` : raw)
    .digest("hex");
  return new NextRequest("https://example.test/api/scheduling/test", {
    method: "POST",
    body: raw,
    headers: {
      [provider === "calendly"
        ? "calendly-webhook-signature"
        : "x-cal-signature-256"]: signature
        ? provider === "calendly"
          ? `t=${t},v1=${digest}`
          : digest
        : "fake",
    },
  });
}
beforeEach(() => {
  rpc.mockClear();
  single.mockClear();
});
afterAll(() => {
  delete process.env.DISCOVER_SCHEDULING_CONNECTIONS;
});
test.each(["calendly", "calcom"])(
  "%s requires provider signature, attribution, matching event and attendee",
  async (provider) => {
    process.env.DISCOVER_SCHEDULING_CONNECTIONS = JSON.stringify([
      {
        id: "test",
        provider,
        creatorId: "creator",
        eventType: "123",
        secret: "secret",
      },
    ]);
    const payload =
      provider === "calendly"
        ? {
            event: "invitee.created",
            created_at: new Date().toISOString(),
            payload: {
              uri: "booking",
              email: "viewer@example.test",
              tracking: { utm_content: "cn_" + id },
              scheduled_event: {
                event_type: "123",
                start_time: "2026-10-01T12:00:00Z",
              },
            },
          }
        : {
            triggerEvent: "BOOKING_CREATED",
            createdAt: new Date().toISOString(),
            payload: {
              uid: "booking",
              eventTypeId: 123,
              status: "ACCEPTED",
              startTime: "2026-10-01T12:00:00Z",
              attendees: [{ email: "viewer@example.test" }],
              metadata: { cn_attribution: id },
            },
          };
    const context = { params: Promise.resolve({ connection: "test" }) };
    expect(
      (await POST(request(provider, payload, false), context)).status,
    ).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    expect((await POST(request(provider, payload), context)).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "confirm_discover_booking_v1",
      expect.objectContaining({
        p_attribution: id,
        p_provider: provider,
        p_booking: "booking",
        p_canceled: false,
      }),
    );
    rpc.mockClear();
    if (provider === "calendly") payload.payload.email = "other@example.test";
    else payload.payload.attendees = [{ email: "other@example.test" }];
    expect(
      (await (await POST(request(provider, payload), context)).json())
        .unattributed,
    ).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  },
);
