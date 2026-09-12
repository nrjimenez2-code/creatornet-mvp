import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { hasQualifyingPurchaseForPost, viewerPurchasedPosts, livePurchasesByReviewers, isVerifiedPurchase } from "@/lib/reviewEligibility";
jest.mock("@/lib/supabaseServer", () => ({}));
const envKeys = ["CREATOR_FIXED_SERVICE_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY"] as const;
const saved = envKeys.map(k => process.env[k]);
type Row = { id: string; buyer_id: string; post_id: string | null; creator_id: string; status: string | null; access_granted: boolean };
let rows: Row[], fixed: Record<string, unknown>, monthly: Record<string, unknown>, readerError: boolean;
const row = (over: Partial<Row> = {}): Row => ({ id: "p", buyer_id: "buyer", post_id: "post", creator_id: "creator", status: "active", access_granted: false, ...over });
const db = createMockClient(op => {
  if (op.kind === "rpc") {
    const id = (op.payload as { p_purchase_id: string }).p_purchase_id;
    return { data: (op.table === "read_fixed_service_entitlement_v1" ? fixed : monthly)[id] ?? { applicable: false, allowed: false, maxAgeSeconds: 0 }, error: readerError ? { message: "synthetic failure" } : null };
  }
  if (op.table === "purchases") {
    const matches = rows.filter(r => Object.entries(op.filters).every(([k, v]) => r[k as keyof Row] === v) &&
      op.inFilters.every(f => f.values.includes(r[f.column as keyof Row])) &&
      r.status !== null && !["refunded", "failed"].includes(r.status));
    return { data: op.columns === "id" ? matches[0] ?? null : matches, error: null };
  }
  if (op.table === "posts") return { data: [{ id: "post", title: "Mentorship" }], error: null };
  return undefined;
});
beforeEach(() => { envKeys.forEach(k => { process.env[k] = "true"; }); rows = [row()]; fixed = {}; monthly = {}; readerError = false; db.ops.length = 0; });
afterAll(() => { envKeys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); });

test.each(["monthly", "fixed"])("current %s entitlement enables writing, offer selection and verified labels without legacy access", async kind => {
  if (kind === "fixed") fixed.p = { applicable: true, allowed: true, maxAgeSeconds: 19 };
  else monthly.p = { allowed: true, maxAgeSeconds: 29 };
  expect(await hasQualifyingPurchaseForPost(db, "buyer", "post")).toBe(true);
  expect(await viewerPurchasedPosts(db, "buyer", "creator")).toEqual([{ post_id: "post", title: "Mentorship" }]);
  const live = await livePurchasesByReviewers(db, "creator", ["buyer"]);
  expect(isVerifiedPurchase(live, "buyer", "post")).toBe(true);
  expect(isVerifiedPurchase(live, "other", "post")).toBe(false);
  expect(rows[0].access_granted).toBe(false);
  expect(db.ops.filter(o => o.kind === "rpc").every(o => (o.payload as any).p_buyer_id === "buyer")).toBe(true);
  expect(db.ops.some(o => o.kind === "update" || o.kind === "insert")).toBe(false);
});
test("a denied earlier purchase cannot hide a later eligible purchase", async () => {
  rows = [row({ id: "old" }), row({ id: "current" })]; monthly.current = { allowed: true, maxAgeSeconds: 29 };
  expect(await hasQualifyingPurchaseForPost(db, "buyer", "post")).toBe(true);
});
test.each(["expired", "refunded", "disputed", "unpaid"])("reader-denied %s purchases cannot write or keep a verified label", async () => {
  fixed.p = { applicable: true, allowed: false, maxAgeSeconds: 0 }; monthly.p = { allowed: true, maxAgeSeconds: 30 };
  expect(await hasQualifyingPurchaseForPost(db, "buyer", "post")).toBe(false);
  expect(await viewerPurchasedPosts(db, "buyer", "creator")).toEqual([]);
  expect(await livePurchasesByReviewers(db, "creator", ["buyer"])).toEqual([]);
  expect(db.ops.some(o => o.table === "read_monthly_mentorship_entitlement_v1")).toBe(false);
});
test.each([null, "refunded", "failed"])("status %s stays denied even if a reader would say yes", async status => {
  rows = [row({ status })]; monthly.p = { allowed: true, maxAgeSeconds: 30 };
  expect(await hasQualifyingPurchaseForPost(db, "buyer", "post")).toBe(false);
  expect(db.ops.some(o => o.kind === "rpc")).toBe(false);
});
test("paid access after monthly exit is governed by the entitlement, not an active-only status filter", async () => {
  rows = [row({ status: "canceled" })]; monthly.p = { allowed: true, maxAgeSeconds: 30 };
  expect(await hasQualifyingPurchaseForPost(db, "buyer", "post")).toBe(true);
});
test("wrong buyer/post/creator cannot borrow another entitlement", async () => {
  monthly.p = { allowed: true, maxAgeSeconds: 30 };
  expect(await hasQualifyingPurchaseForPost(db, "other", "post")).toBe(false);
  expect(await hasQualifyingPurchaseForPost(db, "buyer", "other")).toBe(false);
  expect(await viewerPurchasedPosts(db, "buyer", "other")).toEqual([]);
  expect(await livePurchasesByReviewers(db, "creator", ["other"])).toEqual([]);
});
test("readiness disabled preserves the original legacy gate and never calls new RPCs", async () => {
  envKeys.forEach(k => { process.env[k] = "false"; }); monthly.p = { allowed: true, maxAgeSeconds: 30 };
  expect(await hasQualifyingPurchaseForPost(db, "buyer", "post")).toBe(false);
  rows[0].access_granted = true;
  expect(await hasQualifyingPurchaseForPost(db, "buyer", "post")).toBe(true);
  expect(db.ops.some(o => o.kind === "rpc")).toBe(false);
});
test.each([null, {}, { allowed: true, maxAgeSeconds: 0 }, { allowed: true, maxAgeSeconds: 3601 }, { allowed: true, maxAgeSeconds: 1.5 }])(
  "malformed monthly result %p fails closed", async result => { monthly.p = result; expect(await hasQualifyingPurchaseForPost(db, "buyer", "post")).toBe(false); });
test("reader errors fail closed", async () => {
  monthly.p = { allowed: true, maxAgeSeconds: 30 }; readerError = true;
  expect(await hasQualifyingPurchaseForPost(db, "buyer", "post")).toBe(false);
});
