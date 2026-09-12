import type { SupabaseClient } from "@supabase/supabase-js";
import { membershipAccessSeconds, membershipLedgerReady } from "../lib/membershipAccess";
const originalFixed = process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY;
const originalMonthly = process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY;
const rpc = jest.fn();
const admin = { rpc } as unknown as SupabaseClient;
beforeEach(() => {
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "true";
  process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "true";
  rpc.mockReset();
});
afterAll(() => {
  if (originalFixed === undefined) delete process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY;
  else process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = originalFixed;
  if (originalMonthly === undefined) delete process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY;
  else process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = originalMonthly;
});
test("the owned timed result caps access and does not fall through to monthly or legacy", async () => {
  rpc.mockResolvedValue({ data: { applicable: true, allowed: true, maxAgeSeconds: 19 }, error: null });
  expect(membershipLedgerReady()).toBe(true);
  expect(await membershipAccessSeconds(admin, "purchase", "buyer")).toBe(19);
  expect(rpc.mock.calls).toEqual([["read_fixed_service_entitlement_v1", { p_purchase_id: "purchase", p_buyer_id: "buyer" }]]);
});
test.each([null, {}, { applicable: true, allowed: false, maxAgeSeconds: 0 }, { applicable: true, allowed: true, maxAgeSeconds: 3601 },
  { applicable: true, allowed: true, maxAgeSeconds: 0.5 }, { applicable: true, allowed: true, maxAgeSeconds: "19" }])(
  "denied or malformed timed entitlement %p never uses a fallback", async data => {
    rpc.mockResolvedValue({ data, error: null });
    expect(await membershipAccessSeconds(admin, "purchase", "buyer")).toBe(0); expect(rpc).toHaveBeenCalledTimes(1);
  });
test("database failure cannot become legacy access", async () => {
  rpc.mockResolvedValue({ data: { applicable: false, allowed: true, maxAgeSeconds: 3600 }, error: { message: "Synthetic" } });
  expect(await membershipAccessSeconds(admin, "purchase", "buyer")).toBe(0); expect(rpc).toHaveBeenCalledTimes(1);
});
test("non-fixed purchases still use the monthly owned reader when it is enabled", async () => {
  rpc.mockResolvedValueOnce({ data: { applicable: false, allowed: false, maxAgeSeconds: 0 }, error: null })
    .mockResolvedValueOnce({ data: { allowed: true, maxAgeSeconds: 29 }, error: null });
  expect(await membershipAccessSeconds(admin, "purchase", "buyer")).toBe(29);
  expect(rpc.mock.calls.map(call => call[0])).toEqual(["read_fixed_service_entitlement_v1", "read_monthly_mentorship_entitlement_v1"]);
});
test("fixed-only rollout preserves legacy results without requiring the monthly schema", async () => {
  process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "false";
  rpc.mockResolvedValue({ data: { applicable: false, allowed: true, maxAgeSeconds: 3600 }, error: null });
  expect(await membershipAccessSeconds(admin, "purchase", "buyer")).toBe(3600); expect(rpc).toHaveBeenCalledTimes(1);
});
test("turning off the fixed reader leaves the original monthly lookup unchanged", async () => {
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "false";
  rpc.mockResolvedValue({ data: { allowed: false, maxAgeSeconds: 0 }, error: null });
  expect(await membershipAccessSeconds(admin, "purchase", "buyer")).toBe(0);
  expect(rpc.mock.calls.map(call => call[0])).toEqual(["read_monthly_mentorship_entitlement_v1"]);
});
test("with both readers off the legacy query gate remains off", () => {
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "false";
  process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "false";
  expect(membershipLedgerReady()).toBe(false);
});
