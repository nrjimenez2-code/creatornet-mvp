const mockAbandonRequest=jest.fn(),mockAbandonExecute=jest.fn(),mockUnprepared=jest.fn();
jest.mock("@/lib/mentorshipInstallmentBootstrap",()=>({requestBuyerMentorshipAbandonment:(...a:unknown[])=>mockAbandonRequest(...a),releaseBuyerMentorshipUnpreparedSelection:(...a:unknown[])=>mockUnprepared(...a)}));
jest.mock("@/lib/mentorshipInstallmentAbandonment",()=>({stopBuyerMentorshipUnpaidCheckout:(...a:unknown[])=>mockAbandonExecute(...a)}));
import { NextRequest } from "next/server";
const mockAuth = jest.fn(), mockConfig = jest.fn(), mockObserve = jest.fn(), mockRead = jest.fn(), mockClient = jest.fn();
const mockStop=jest.fn(),mockReviewRetry=jest.fn(),mockPayRetry=jest.fn();
jest.mock("@/lib/mentorshipInstallmentRetry",()=>({reviewBuyerMentorshipRetry:(...a:unknown[])=>mockReviewRetry(...a),
  executeBuyerMentorshipRetry:(...a:unknown[])=>mockPayRetry(...a)}));
const mockBank=jest.fn(),mockCheckPayment=jest.fn();
const mockPrepareCard=jest.fn(),mockVerifyCard=jest.fn(),mockOpenCard=jest.fn();
jest.mock("@/lib/mentorshipInstallmentCardSetup",()=>({prepareBuyerMentorshipCardSetup:(...a:unknown[])=>mockPrepareCard(...a),
  verifyBuyerMentorshipSavedCard:(...a:unknown[])=>mockVerifyCard(...a),readBuyerMentorshipCardSetupRedirect:(...a:unknown[])=>mockOpenCard(...a)}));
jest.mock("@/lib/mentorshipInstallmentPaymentRecovery",()=>({readBuyerMentorshipBankChallenge:(...a:unknown[])=>mockBank(...a),
  recoverBuyerMentorshipPayment:(...a:unknown[])=>mockCheckPayment(...a)}));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => mockAuth() }));
jest.mock("@/lib/installments/contextServer", () => ({ exactContextServerConfig: () => mockConfig() }));
jest.mock("@/lib/installments/contextRuntime", () => ({ createExactContextRuntime: () => ({ observeContext: () => mockObserve() }) }));
jest.mock("@/lib/mentorshipInstallmentReservation", () => ({ readBuyerMentorshipInstallmentReservation: (...a: unknown[]) => mockRead(...a) }));
jest.mock("@supabase/supabase-js", () => ({ createClient: (...a: unknown[]) => mockClient(...a) }));
import { GET,POST } from "@/app/api/installments/reservations/[requestId]/route";
const requestId = "10000000-0000-4000-8000-000000000001", buyerId = "10000000-0000-4000-8000-000000000002";
const previous = { ...process.env }, context = { mode: "test" }, evidence = { observation: "synthetic" };
beforeEach(() => {
  jest.clearAllMocks(); process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY = "true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_READY = "false";
  mockAuth.mockResolvedValue({ id: buyerId }); mockConfig.mockReturnValue({ approvedContext: context,
    configuredSupabaseUrl: "https://example.invalid", supabaseServiceKey: "synthetic" });
  mockObserve.mockResolvedValue({ contextEvidence: evidence }); mockClient.mockReturnValue({});
  mockRead.mockResolvedValue({ requestId, status: "reserved", providerOperationsAllowed: false });
});
afterAll(() => { process.env = previous; });
const call = (id = requestId, query = "") => GET(new NextRequest(`https://example.invalid/api/installments/reservations/${id}${query}`), { params: Promise.resolve({ requestId: id }) });
test("signed-in buyer can recover saved acceptance while new checkout is paused", async () => {
  const response = await call(); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie, Authorization");
  expect(mockRead).toHaveBeenCalledWith({ admin: {}, buyerId, requestId, context, contextEvidence: evidence });
  expect(await response.json()).toMatchObject({ status: "reserved", providerOperationsAllowed: false });
});
test("unauthenticated requests cannot observe provider context or read records", async () => {
  mockAuth.mockResolvedValue(null); expect((await call()).status).toBe(401);
  expect(mockConfig).not.toHaveBeenCalled(); expect(mockRead).not.toHaveBeenCalled();
});
test("unapplied schema avoids all financial reads", async () => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY = "false";
  expect((await call()).status).toBe(409); expect(mockRead).not.toHaveBeenCalled();
});
test.each([["invalid", ""], [requestId, "?buyer_id=forged"], [requestId, "?amount_cents=1"]])("invalid request %s %s never observes providers", async (id, query) => {
  expect((await call(id, query)).status).toBe(400); expect(mockObserve).not.toHaveBeenCalled();
});
test("failed context observation does not permit saved-plan access", async () => {
  mockObserve.mockRejectedValue(Error("private provider error"));
  const response = await call(); expect(response.status).toBe(409); expect(mockRead).not.toHaveBeenCalled();
  expect(JSON.stringify(await response.json())).not.toContain("private provider error");
});
test("unknown or foreign request returns a generic not-found response", async () => {
  mockRead.mockResolvedValue(null); expect((await call()).status).toBe(404);
});

function enableStop() {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY="true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_DEBIT_STOP_READY="true";
  mockConfig.mockReturnValue({approvedContext:{...context,siteOrigin:"https://example.invalid"},configuredSupabaseUrl:"https://example.invalid",supabaseServiceKey:"synthetic"});
  mockClient.mockReturnValue({rpc:mockStop});
  mockStop.mockResolvedValue({data:{status:"new_debits_stopped",reservationId:"10000000-0000-4000-8000-000000000003",revokedAt:"2026-09-21T05:00:00Z",pending:[]}});
}
function stop(body:unknown={action:"revoke_debit"},origin="https://example.invalid") {
  return POST(new NextRequest(`https://example.invalid/api/installments/reservations/${requestId}`,{
    method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(body)}),{params:Promise.resolve({requestId})});
}
test("debit revocation uses authenticated ownership while new checkout stays disabled",async()=>{
  enableStop();const response=await stop();expect(response.status).toBe(200);
  expect(mockStop).toHaveBeenCalledWith("revoke_buyer_mentorship_debit_v1",{p_request_id:requestId,p_buyer_id:buyerId,p_context:{...context,siteOrigin:"https://example.invalid"}});
  const result=await response.json();expect(result).toMatchObject({status:"new_debits_stopped",pendingPayments:0});
  expect(result.message).toContain("balance remains due");expect(result).not.toHaveProperty("reservationId");
});
test("already-admitted payment stays visibly pending, not falsely canceled",async()=>{
  enableStop();mockStop.mockResolvedValue({data:{status:"admitted_payment_pending",reservationId:"10000000-0000-4000-8000-000000000003",revokedAt:"2026-09-21T05:00:00Z",pending:[{invoiceId:"in_original"}]}});
  const response=await stop(),result=await response.json();expect(response.status).toBe(200);
  expect(result).toMatchObject({status:"admitted_payment_pending",pendingPayments:1});expect(JSON.stringify(result)).not.toContain("in_original");
});
test.each(["unauthenticated","foreign origin","foreign owner","forged buyer","disabled"])("%s cannot revoke a buyer debit",async condition=>{
  enableStop();if(condition==="unauthenticated")mockAuth.mockResolvedValue(null);
  if(condition==="foreign owner")mockRead.mockResolvedValue(null);
  if(condition==="disabled")process.env.CREATOR_MENTORSHIP_INSTALLMENT_DEBIT_STOP_READY="false";
  const response=await stop(condition==="forged buyer"?{action:"revoke_debit",buyer_id:buyerId}:{action:"revoke_debit"},condition==="foreign origin"?"https://other.invalid":"https://example.invalid");
  expect(response.status).toBe(condition==="unauthenticated"?401:condition==="foreign origin"?403:condition==="foreign owner"?404:condition==="disabled"?409:400);
  expect(mockStop).not.toHaveBeenCalled();
});

function enableBank() {
  enableStop();process.env.CREATOR_MENTORSHIP_INSTALLMENT_DEBIT_STOP_READY="false";
  for(const flag of ["BANK_SCHEMA_READY","BANK_READY","RECOVERY_SCHEMA_READY","RECOVERY_READY"])process.env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]="true";
  mockBank.mockResolvedValue({status:"bank_verification_ready",clientSecret:"pi_owned_secret_synthetic",publishableKey:"pk_test_synthetic",amountCents:3333,paymentNumber:2});
  mockCheckPayment.mockResolvedValue({status:"payment_recovery_recorded",outcome:"paid_accounted"});
}
test("bank capability is authenticated, same-origin and never cacheable",async()=>{
  enableBank();const response=await stop({action:"bank_verification",invoiceId:"in_original"});
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mockBank).toHaveBeenCalledWith({buyerId,requestId,invoiceId:"in_original"});expect(mockStop).not.toHaveBeenCalled();
});
test.each(["unauthenticated","foreign origin","foreign owner","forged buyer","disabled"])("bank %s cannot obtain a client secret",async problem=>{
  enableBank();if(problem==="unauthenticated")mockAuth.mockResolvedValue(null);if(problem==="foreign owner")mockRead.mockResolvedValue(null);
  if(problem==="disabled")process.env.CREATOR_MENTORSHIP_INSTALLMENT_BANK_READY="false";
  const body={action:"bank_verification",invoiceId:"in_original",...(problem==="forged buyer"?{buyerId:"forged"}:{})};
  const response=await stop(body,problem==="foreign origin"?"https://other.invalid":"https://example.invalid");
  expect(response.status).toBe(problem==="unauthenticated"?401:problem==="foreign origin"?403:problem==="foreign owner"?404:problem==="disabled"?409:400);
  expect(mockBank).not.toHaveBeenCalled();expect(JSON.stringify(await response.json())).not.toContain("clientSecret");
});
test("post-SDK check calls original receipt recovery and does not trust browser payment status",async()=>{
  enableBank();const response=await stop({action:"check_payment",invoiceId:"in_original"});
  expect(response.status).toBe(200);expect(mockCheckPayment).toHaveBeenCalledWith({buyerId,requestId,invoiceId:"in_original"});
  expect(mockBank).not.toHaveBeenCalled();expect(mockStop).not.toHaveBeenCalled();
  expect((await stop({action:"check_payment",invoiceId:"in_original",paid:true})).status).toBe(400);
});
function enableCard() {
  enableBank();for(const flag of ["CARD_SETUP_SCHEMA_READY","CARD_SETUP_READY","CARD_SETUP_PUBLISH_READY","SAVED_CARD_SCHEMA_READY","SAVED_CARD_READY"])
    process.env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]="true";
  mockPrepareCard.mockResolvedValue({status:"prepared_unpublished",setupId:requestId,sessionId:"cs_test_private"});
  mockVerifyCard.mockResolvedValue({status:"card_saved_payment_not_attempted",setupId:requestId});
  mockOpenCard.mockResolvedValue({status:"card_setup_ready",setupId:requestId,url:"https://checkout.stripe.com/c/setup/cs_test_original"});
}
test.each(["prepare_card","verify_card","open_card"])("%s uses authenticated owner and exact original identifiers",async action=>{
  enableCard();const consent={accepted:true,consentVersion:"replacement-card-setup-v1"};
  const response=await stop({action,invoiceId:"in_original",setupId:requestId,...(action==="prepare_card"?{consent}:{})});
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
  const mock=action==="prepare_card"?mockPrepareCard:action==="verify_card"?mockVerifyCard:mockOpenCard;
  expect(mock).toHaveBeenCalledWith({buyerId,requestId,invoiceId:"in_original",setupId:requestId,...(action==="prepare_card"?{consent}:{})});
  expect(JSON.stringify(await response.json())).not.toContain("cs_test_private");expect(mockStop).not.toHaveBeenCalled();
});
test.each(["unauthenticated","foreign origin","foreign owner","forged buyer","disabled","no consent"])("card setup refuses %s",async problem=>{
  enableCard();if(problem==="unauthenticated")mockAuth.mockResolvedValue(null);if(problem==="foreign owner")mockRead.mockResolvedValue(null);
  if(problem==="disabled")process.env.CREATOR_MENTORSHIP_INSTALLMENT_CARD_SETUP_READY="false";
  const body={action:"prepare_card",invoiceId:"in_original",setupId:requestId,consent:{accepted:problem!=="no consent",consentVersion:"replacement-card-setup-v1"},
    ...(problem==="forged buyer"?{buyerId:"forged"}:{})};
  const response=await stop(body,problem==="foreign origin"?"https://other.invalid":"https://example.invalid");
  expect(response.status).toBe(problem==="unauthenticated"?401:problem==="foreign origin"?403:problem==="foreign owner"?404:problem==="disabled"?409:400);
  expect(mockPrepareCard).not.toHaveBeenCalled();expect(mockOpenCard).not.toHaveBeenCalled();
});

function enableRetry() {
  enableCard();for(const flag of ["RETRY_ACTIONS_READY","RETRY_SCHEMA_READY","RETRY_READY","RETRY_RECEIPT_READY","RETRY_RECOVERY_SCHEMA_READY",
    "LATER_RECEIPT_SCHEMA_READY","RECONCILIATION_READY"])process.env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]="true";
  mockReviewRetry.mockResolvedValue({status:"payment_review",quote:{id:requestId,amountCents:3333,confirmed:false}});
  mockPayRetry.mockResolvedValue({status:"payment_recovery_recorded",outcome:"action_required"});
}
const retryBody=(action="pay_retry")=>({action,invoiceId:"in_original",setupId:requestId,quoteId:requestId,
  ...(action==="review_retry"?{futureCardOption:false}:{consent:{accepted:true,consentVersion:"single-invoice-pay-now-v1"}})});
test.each(["review_retry","pay_retry"])("%s reuses saved quote and authenticated ownership",async action=>{
  enableRetry();const body=retryBody(action),response=await stop(body);
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
  const {action:_,...fields}=body;
  expect(action==="review_retry"?mockReviewRetry:mockPayRetry).toHaveBeenCalledWith({buyerId,requestId,...fields});
  expect(action==="review_retry"?mockPayRetry:mockReviewRetry).not.toHaveBeenCalled();expect(mockStop).not.toHaveBeenCalled();
});
test.each(["unauthenticated","foreign origin","foreign owner","forged amount","invalid quote","no consent","wrong consent","extra consent","disabled","schema disabled"])("retry rejects %s before execution",async problem=>{
  enableRetry();const body:any=retryBody();
  if(problem==="unauthenticated")mockAuth.mockResolvedValue(null);
  if(problem==="foreign owner")mockRead.mockResolvedValue(null);
  if(problem==="forged amount")body.amountCents=1;
  if(problem==="invalid quote")body.quoteId="forged";
  if(problem==="no consent")body.consent.accepted=false;
  if(problem==="wrong consent")body.consent.consentVersion="replacement-card-setup-v1";
  if(problem==="extra consent")body.consent.extra=true;
  if(problem==="disabled")process.env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_ACTIONS_READY="false";
  if(problem==="schema disabled")process.env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_RECOVERY_SCHEMA_READY="false";
  const response=await stop(body,problem==="foreign origin"?"https://foreign.invalid":"https://example.invalid");
  expect(response.status).toBe(problem==="unauthenticated"?401:problem==="foreign origin"?403:problem==="foreign owner"?404:
    ["disabled","schema disabled"].includes(problem)?409:400);
  expect(mockPayRetry).not.toHaveBeenCalled();expect(mockReviewRetry).not.toHaveBeenCalled();
});
test("uncertain retry returns generic review error without exposing provider details",async()=>{
  enableRetry();mockPayRetry.mockRejectedValueOnce(Error("private Stripe response"));
  const response=await stop(retryBody());expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).not.toContain("private Stripe response");expect(mockPayRetry).toHaveBeenCalledTimes(1);
});
test("review refuses a non-boolean future choice",async()=>{
  enableRetry();expect((await stop({...retryBody("review_retry"),futureCardOption:"true"})).status).toBe(400);
  expect(mockReviewRetry).not.toHaveBeenCalled();
});

function enableAbandonment(){
  for(const flag of ["ABANDONMENT_ACTIONS_READY","BOOTSTRAP_SCHEMA_READY","ABANDONMENT_SCHEMA_READY","ABANDONMENT_REQUEST_READY",
    "ABANDONMENT_OPERATIONS_SCHEMA_READY","ABANDONMENT_PROOF_SCHEMA_READY","ABANDONMENT_EXECUTOR_READY","ABANDONMENT_RELEASE_SCHEMA_READY","ABANDONMENT_RELEASE_READY"])
    process.env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]="true";
  mockConfig.mockReturnValue({approvedContext:{...context,siteOrigin:"https://example.invalid"},configuredSupabaseUrl:"https://example.invalid",supabaseServiceKey:"synthetic"});
  mockAbandonRequest.mockResolvedValue({status:"stop_requested"});mockAbandonExecute.mockResolvedValue({status:"released",requestId,releasedAt:new Date().toISOString(),providerOperationsAllowed:false});
}
test("owned abandonment delegates protocol-specific stop ordering and exposes no provider proof",async()=>{
  enableAbandonment();const response=await stop({action:"abandon_unpaid"});expect(response.status).toBe(200);
  expect(mockAbandonRequest).not.toHaveBeenCalled();expect(mockAbandonExecute).toHaveBeenCalledWith({buyerId,requestId,requestStop:true});
  expect(await response.json()).toMatchObject({status:"released",providerOperationsAllowed:false});
});
test.each(["unauthenticated","foreign origin","foreign owner","forged buyer","disabled"])("%s cannot abandon an unpaid purchase",async issue=>{
  enableAbandonment();if(issue==="unauthenticated")mockAuth.mockResolvedValue(null);
  if(issue==="foreign owner")mockRead.mockResolvedValue(null);
  if(issue==="disabled")process.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_ACTIONS_READY="false";
  const response=await stop(issue==="forged buyer"?{action:"abandon_unpaid",buyerId}:{action:"abandon_unpaid"},issue==="foreign origin"?"https://other.invalid":"https://example.invalid");
  expect(response.status).toBe(issue==="unauthenticated"?401:issue==="foreign origin"?403:issue==="foreign owner"?404:issue==="disabled"?409:400);
  expect(mockAbandonRequest).not.toHaveBeenCalled();expect(mockAbandonExecute).not.toHaveBeenCalled();
});
test("unsettled abandonment returns recovery status without internal provider identities",async()=>{
  enableAbandonment();mockAbandonExecute.mockResolvedValue({status:"stopped_unreleased",proof:{subscriptionId:"sub_private"}});
  const response=await stop({action:"abandon_unpaid"});expect(await response.json()).toEqual({requestId,status:"reconciliation_required",providerOperationsAllowed:false});
});

test.each(["released","prepared_or_uncertain","error"])("abandonment first checks unprepared outcome %s without fabricating operations",async outcome=>{
  enableAbandonment();process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY="true";
  try{
    if(outcome==="error")mockUnprepared.mockRejectedValue(Error("private"));
    else mockUnprepared.mockResolvedValue({status:outcome,requestId,releasedAt:new Date().toISOString(),providerOperationsAllowed:false});
    const response=await stop({action:"abandon_unpaid"});expect(response.status).toBe(outcome==="error"?409:200);
    expect(mockUnprepared).toHaveBeenCalledWith({buyerId,requestId});
    if(outcome==="prepared_or_uncertain")expect(mockAbandonExecute).toHaveBeenCalledWith({buyerId,requestId,requestStop:true});
    else {expect(mockAbandonRequest).not.toHaveBeenCalled();expect(mockAbandonExecute).not.toHaveBeenCalled();}
  }finally{delete process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY;}
});

test.each(["ready","released","missing gate"])("abandonment UI capability is %s",async state=>{
  enableAbandonment();for(const flag of ["ABANDONMENT_UI_READY","UNPREPARED_RELEASE_SCHEMA_READY","UNPREPARED_RELEASE_READY"])
    process.env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]="true";
  try{
    if(state==="released")mockRead.mockResolvedValue({requestId,status:"reserved",releasedAt:new Date().toISOString(),providerOperationsAllowed:false});
    if(state==="missing gate")process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY="false";
    expect(await (await call()).json()).toMatchObject({canAbandonUnpaid:state==="ready"});
  }finally{for(const flag of ["ABANDONMENT_UI_READY","UNPREPARED_RELEASE_SCHEMA_READY","UNPREPARED_RELEASE_READY"])
    delete process.env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`];}
});


test("explicit nonpayable capability enables the existing release fallback without calling provider stop",async()=>{
 enableAbandonment();process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY="true";
 process.env.CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_READY="true";
 try {
  mockUnprepared.mockResolvedValue({status:"released",requestId,releasedAt:new Date().toISOString(),providerOperationsAllowed:false});
  expect((await stop({action:"abandon_unpaid"})).status).toBe(200);
  expect(mockUnprepared).toHaveBeenCalledWith({buyerId,requestId,includeNonpayablePreparation:true});
  expect(mockAbandonRequest).not.toHaveBeenCalled();expect(mockAbandonExecute).not.toHaveBeenCalled();
 }finally {delete process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY;delete process.env.CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_READY;}
});
