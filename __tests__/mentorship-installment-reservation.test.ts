import type { SupabaseClient } from "@supabase/supabase-js";
import { mentorshipInstallmentQuote } from "@/lib/mentorshipInstallmentQuote";
import { reserveBuyerMentorshipInstallments, readBuyerMentorshipInstallmentReservation, readBuyerMentorshipBootstrapReservation } from "@/lib/mentorshipInstallmentReservation";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { version: "exact-payment-context-v1", mode: "test", platformAccountId: "acct_test",
  supabaseProjectRef: "abcdefghijklmnopqrst", siteOrigin: "https://synthetic-mentorship.vercel.app" };
const evidence = { approvedContext: context, vercelEnvironment: "preview", stripeSecretKeyMode: "test", stripePublishableKeyMode: "test",
  observedPlatformAccountId: context.platformAccountId, observedSupabaseProjectRef: context.supabaseProjectRef,
  configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: context.siteOrigin };
const fees = { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic" };
const product = { id: id(3), creator_id: id(2), title: "Mentorship", type: "mentorship", price_cents: 10001,
  currency: "usd", fixed_service_months: 10, installment_options: [3], active: true };
const quoteArgs = { product, buyerId: id(1), postId: id(4), paymentCount: 3, firstPaymentFees: fees, renewalFees: fees };
const quote = mentorshipInstallmentQuote(quoteArgs);
const single = jest.fn(), rpc = jest.fn(() => ({ single }));
const args = { ...quoteArgs, admin: { rpc } as unknown as SupabaseClient, context, contextEvidence: evidence,
  origin: context.siteOrigin, requestId: id(5), acceptance: { accepted: true, version: quote.terms.version, fingerprint: quote.fingerprint } };
const row = { id: id(6), request_id: id(5), attempt_id: id(7), buyer_id: id(1), creator_id: id(2), product_id: id(3), post_id: id(4),
  context, terms: quote.terms, fingerprint: quote.fingerprint, status: "reserved", destination_id: "acct_creator", accepted_at: "2026-09-21T02:00:00Z" };
beforeEach(() => { jest.clearAllMocks(); single.mockResolvedValue({ data: row, error: null }); });
test("passes only the server-rebuilt quote and returns acceptance without payment authority", async () => {
  const result = await reserveBuyerMentorshipInstallments(args);
  expect(rpc).toHaveBeenCalledWith("reserve_buyer_mentorship_installments_v1", {
    p_request_id: id(5), p_buyer_id: id(1), p_product_id: id(3), p_post_id: id(4), p_context: context,
    p_terms_text: JSON.stringify(quote.terms), p_fingerprint: quote.fingerprint,
  });
  expect(result).toMatchObject({ id: id(6), attemptId: id(7), providerOperationsAllowed: false, status: "reserved" });
  expect(result).not.toHaveProperty("url");
});
test.each([null, { ...args.acceptance, accepted: false }, { ...args.acceptance, fingerprint: "old" },
  { ...args.acceptance, amountCents: 1 }, { ...args.acceptance, buyerId: id(2) }])("invalid consent %p does not reserve", async acceptance => {
  await expect(reserveBuyerMentorshipInstallments({ ...args, acceptance })).rejects.toThrow("needs review");
  expect(rpc).not.toHaveBeenCalled();
});
test("cross-origin acceptance never reaches the database", async () => {
  await expect(reserveBuyerMentorshipInstallments({ ...args, origin: "https://other.example" })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
test("mismatched independently observed account prevents reservation", async () => {
  await expect(reserveBuyerMentorshipInstallments({ ...args, contextEvidence: { ...evidence, observedPlatformAccountId: "acct_other" } })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
test("changed server pricing invalidates the buyer's stale acceptance", async () => {
  await expect(reserveBuyerMentorshipInstallments({ ...args, product: { ...product, price_cents: 11001 } })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
test.each([
  { buyer_id: id(2) }, { request_id: id(8) }, { post_id: id(8) }, { product_id: id(8) }, { creator_id: id(8) },
  { fingerprint: "wrong" }, { status: "paid" }, { terms: { ...quote.terms, paymentCount: 4 } },
  { context: { ...context, mode: "live" } }, { accepted_at: "invalid" }, { destination_id: "not-account" },
])("rejects inconsistent database reply %p", async changed => {
  single.mockResolvedValue({ data: { ...row, ...changed }, error: null });
  await expect(reserveBuyerMentorshipInstallments(args)).rejects.toThrow("needs review");
  expect(rpc).toHaveBeenCalledTimes(1);
});
test("JSONB key reordering does not falsely invalidate saved terms", async () => {
  single.mockResolvedValue({ data: { ...row, terms: Object.fromEntries(Object.entries(row.terms).reverse()) }, error: null });
  expect((await reserveBuyerMentorshipInstallments(args)).fingerprint).toBe(quote.fingerprint);
});
test("lost RPC reply never starts a replacement attempt or discloses raw errors", async () => {
  single.mockRejectedValue(Error("sensitive provider detail"));
  await expect(reserveBuyerMentorshipInstallments(args)).rejects.toThrow("Installment acceptance needs review");
  expect(rpc).toHaveBeenCalledTimes(1);
});

function recoveryDatabase(changed: Record<string, unknown> = {}, absent = false) {
  const q = { select: jest.fn(), eq: jest.fn(), contains: jest.fn(), maybeSingle: jest.fn().mockResolvedValue({
    data: absent ? null : { ...row, terms_text: JSON.stringify(quote.terms), ...changed }, error: null }) };
  [q.select, q.eq, q.contains].forEach(fn => fn.mockReturnValue(q));
  const from = jest.fn(() => q);
  return { q, from, admin: { from } as unknown as SupabaseClient };
}
test("owned recovery uses original terms and never queries the current catalog or reserves again", async () => {
  const db = recoveryDatabase({ terms: Object.fromEntries(Object.entries(quote.terms).reverse()) });
  const saved = await readBuyerMentorshipInstallmentReservation({ ...args, admin: db.admin });
  expect(saved).toMatchObject({ requestId: id(5), fingerprint: quote.fingerprint, terms: quote.terms, providerOperationsAllowed: false });
  expect(saved).not.toHaveProperty("destinationId"); expect(saved).not.toHaveProperty("attemptId");
  expect(db.from).toHaveBeenCalledTimes(1); expect(db.from).toHaveBeenCalledWith("buyer_mentorship_installment_reservations_v1");
  expect(db.q.eq).toHaveBeenCalledWith("buyer_id", id(1)); expect(db.q.eq).toHaveBeenCalledWith("request_id", id(5));
  expect(rpc).not.toHaveBeenCalled();
});
test("missing owned recovery record returns no plan", async () => {
  const db = recoveryDatabase({}, true);
  expect(await readBuyerMentorshipInstallmentReservation({ ...args, admin: db.admin })).toBeNull();
});
test.each([{ buyer_id: id(8) }, { request_id: id(8) }, { context: { ...context, platformAccountId: "acct_other" } },
  { terms_text: JSON.stringify({ ...quote.terms, amountCents: 1 }) }, { terms: { ...quote.terms, paymentCount: 4 } },
  { fingerprint: "wrong" }, { status: "paid" }])("recovery rejects changed ownership or acceptance %p", async changed => {
  const db = recoveryDatabase(changed);
  await expect(readBuyerMentorshipInstallmentReservation({ ...args, admin: db.admin })).rejects.toThrow("needs review");
});

test("internal bootstrap recovery binds original private identities without expanding the public response", async () => {
  const db = recoveryDatabase();
  const saved = await readBuyerMentorshipBootstrapReservation({ ...args, admin: db.admin });
  expect(saved).toMatchObject({ id: row.id, attemptId: row.attempt_id, buyerId: row.buyer_id, destinationId: row.destination_id,
    fingerprint: quote.fingerprint, terms: quote.terms, providerOperationsAllowed: false });
  expect(db.from).toHaveBeenCalledTimes(2);
  expect(await readBuyerMentorshipInstallmentReservation({ ...args, admin: db.admin })).not.toHaveProperty("destinationId");
});
test.each([{ fingerprint: "changed" }, { destination_id: "not-account" }, { buyer_id: id(8) }, { product_id: id(8) },
  { context: { ...context, platformAccountId: "acct_other" } }, { status: "paid" }])("internal bootstrap read rejects changed private binding %p", async changed => {
  const db = recoveryDatabase();
  db.q.maybeSingle.mockResolvedValueOnce({ data: { ...row, terms_text: JSON.stringify(quote.terms) }, error: null })
    .mockResolvedValueOnce({ data: { ...row, ...changed }, error: null });
  await expect(readBuyerMentorshipBootstrapReservation({ ...args, admin: db.admin })).rejects.toThrow();
});

test.each(["active","released","wrong owner","invalid timestamp"])("original request release projection: %s",async scenario=>{
  const previous=process.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY;
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY="true";
  try{
    const at=scenario==="active"?null:scenario==="invalid timestamp"?"invalid":new Date().toISOString();
    const db=recoveryDatabase({released_at:at,...(scenario==="wrong owner"?{buyer_id:id(9)}:{})});
    if(["active","released"].includes(scenario))expect(await readBuyerMentorshipInstallmentReservation({...args,admin:db.admin}))
      .toMatchObject({requestId:id(5),releasedAt:at,providerOperationsAllowed:false});
    else await expect(readBuyerMentorshipInstallmentReservation({...args,admin:db.admin})).rejects.toThrow("needs review");
  }finally{
    if(previous===undefined)delete process.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY;
    else process.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY=previous;
  }
});
