import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeMembershipCursor, listManagedMemberships, membershipManagementReady } from "@/lib/membershipManagement";
import { managementFixture } from "../test-support/membership-management-fixtures";
import { membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
const buyer = "16000000-0000-4000-8000-000000000003";
function harness() {
  const item = managementFixture(), body = { view: "buyer", items: [item], nextCursor: null as unknown };
  const rpc = jest.fn(async () => ({ data: body, error: null as unknown })), profiles = { data: [{ id: item.counterpartyId, username: "mentor", full_name: "Mentor Name" }], error: null as unknown };
  const q = { in: jest.fn(async () => profiles) }, select = jest.fn(() => q), from = jest.fn(() => ({ select }));
  const admin = { rpc, from } as unknown as SupabaseClient;
  const run = () => listManagedMemberships(admin, context, buyer, "buyer", null);
  return { item, body, rpc, profiles, q, from, run };
}
test("step 5: management uses the authenticated actor and returns display columns only", async () => {
  const h = harness(), result = await h.run();
  expect(h.rpc).toHaveBeenCalledWith("read_monthly_mentorship_management_v1",
    { p_actor_id: buyer, p_view: "buyer", p_context: context, p_after: null, p_after_id: null, p_limit: 12 });
  expect(result.items[0].counterpartyName).toBe("Mentor Name");
});
test("step 5: names failing to load do not replace owned financial state", async () => {
  const h = harness(); h.profiles.error = Error("Synthetic profile failure"); expect((await h.run()).items[0].id).toBe(h.item.id);
});
test("step 5: rejected optional profile request does not blank membership management", async () => {
  const h = harness(); h.q.in.mockRejectedValueOnce(Error("Synthetic network failure")); expect((await h.run()).items[0].id).toBe(h.item.id);
});
test.each(["view", "owner", "quote", "duplicate", "limit"])("step 5: malformed management projection %s is rejected", async field => {
  const h = harness();
  if (field === "view") h.body.view = "creator";
  if (field === "owner") h.item.id = "bad";
  if (field === "quote") h.item.quote.membershipId = "24000000-0000-4000-8000-000000000001";
  if (field === "duplicate") h.body.items.push(h.item);
  if (field === "limit") h.body.items = Array.from({ length: 13 }, () => h.item);
  await expect(h.run()).rejects.toThrow(); expect(h.from).not.toHaveBeenCalled();
});
test("step 5: cursor preserves provider/database timestamp precision", async () => {
  const h = harness(), value = { acceptedAt: "2026-09-09T22:00:00.123456+00:00", id: h.item.id }; h.body.nextCursor = value;
  const result = await h.run(); expect(decodeMembershipCursor(result.nextCursor)).toEqual(value);
});
test.each(["", "not+base64", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ id: buyer, acceptedAt: "infinity" })).toString("base64url")])(
  "step 5: invalid cursor is refused", value => { expect(() => decodeMembershipCursor(value)).toThrow(); });
test("step 2: paused new billing and paused recovery do not disable owned management", () => {
  expect(membershipManagementReady({ ...membershipTestEnv, CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY: "false", CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_READY: "false" })).toBe(true);
});
test.each(["CREATOR_MONTHLY_MENTORSHIPS_MANAGEMENT_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_MANAGEMENT_READY"])(
  "step 10: missing %s disables management", key => { expect(membershipManagementReady({ ...membershipTestEnv, [key]: "false" })).toBe(false); });
