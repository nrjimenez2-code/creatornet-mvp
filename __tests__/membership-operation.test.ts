import type { SupabaseClient } from "@supabase/supabase-js";
import { runMembershipOperation, type MembershipProviderRequest } from "@/lib/membershipOperation";
const agreementId = "15000000-0000-4000-8000-000000000001", actorId = "15000000-0000-4000-8000-000000000002";
const operationId = "15000000-0000-4000-8000-000000000003";
const context = { stripeAccountId: "acct_fixture", mode: "test" as const, apiVersion: "2025-10-29.clover",
  siteOrigin: "https://membership.example.invalid", supabaseProjectRef: "nwqfofezfzljhxolkycz" };
let request: MembershipProviderRequest;
const lookup = jest.fn();
const from = jest.fn(() => { const q: { select: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock } = { select: jest.fn(() => q), eq: jest.fn(() => q), maybeSingle: lookup }; return q; });
let existingOnly = false, currentRevision = 0;
const rpc = jest.fn(), observe = jest.fn(), create = jest.fn(), retrieve = jest.fn(), validate = jest.fn();
let op: Record<string, unknown>, env: Record<string, string>;
const result = { id: "cus_fixture", lastResponse: { requestId: "req_fixture" } };
const run = () => runMembershipOperation({ existingOnly, admin: { rpc, from } as unknown as SupabaseClient, agreementId, actorId, revision: currentRevision,
  kind: "customer", scope: "initial", context, request, env, observeContext: observe, create, retrieve, validate });
beforeEach(() => {
  request = { method: "POST", path: "/v1/customers", params: { metadata: { membership_id: agreementId } } };
  jest.resetAllMocks(); existingOnly = false; currentRevision = 0;
  from.mockImplementation(() => { const q: { select: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock } = { select: jest.fn(() => q), eq: jest.fn(() => q), maybeSingle: lookup }; return q; });
  lookup.mockImplementation(async()=>({data:{...op},error:null})); env = { CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY: "true",
    CREATOR_MONTHLY_MENTORSHIPS_OPERATIONS_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY: "true" };
  op = { id: operationId, agreement_id: agreementId, kind: "customer", scope_key: "initial", request,
    agreement_revision: 0, dispatched_at: new Date().toISOString(), status: "dispatched" };
  rpc.mockImplementation(async name => ({ data: name === "claim_monthly_mentorship_operation_v1" ? op : true, error: null }));
  observe.mockResolvedValue(context); create.mockResolvedValue(result); retrieve.mockResolvedValue(result);
});
test.each(["CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_OPERATIONS_SCHEMA_READY",
  "CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY"])("steps 1/8: gate %s prevents observation and dispatch", async key => {
  env[key] = "false"; await expect(run()).rejects.toThrow("not enabled"); expect(observe).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});
test("step 8: durable claim precedes exactly keyed dispatch and completion requires request evidence", async () => {
  expect(await run()).toEqual(result);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(request, { idempotencyKey: `creatornet-membership:${operationId}`, maxNetworkRetries: 0 });
  expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  expect(rpc.mock.calls[1][0]).toBe("complete_monthly_mentorship_operation_v1");
  expect(validate).toHaveBeenCalledWith(result);
});
test("step 8: retry after an uncertain provider response reuses the same saved identity and request", async () => {
  create.mockRejectedValueOnce(new Error("Synthetic lost response")); await expect(run()).rejects.toThrow("lost response");
  await run(); expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
});
test("step 8: completed operations are retrieved, not recreated even after key expiry", async () => {
  op.status = "complete"; op.provider_id = result.id; op.dispatched_at = "2000-01-01T00:00:00Z";
  expect(await run()).toEqual(result); expect(retrieve).toHaveBeenCalledWith(result.id); expect(create).not.toHaveBeenCalled();
});
test.each(["review", "expired", "revision"])("step 8: %s state cannot authorize a provider retry", async state => {
  if (state === "review") op.status = "review_required";
  if (state === "expired") op.dispatched_at = "2000-01-01T00:00:00Z";
  if (state === "revision") op.agreement_revision = 1;
  await expect(run()).rejects.toThrow("reconciliation"); expect(create).not.toHaveBeenCalled();
});
test("step 8: changed account observation stops before dispatch", async () => {
  observe.mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, stripeAccountId: "acct_other" });
  await expect(run()).rejects.toThrow("context changed"); expect(create).not.toHaveBeenCalled();
});
test("step 8: a provider result that fails validation is not marked complete", async () => {
  validate.mockImplementation(() => { throw Error("Synthetic ownership mismatch"); });
  await expect(run()).rejects.toThrow("ownership mismatch"); expect(rpc).toHaveBeenCalledTimes(1);
});
test("step 8: a different saved provider object cannot be substituted on retrieval", async () => {
  op.status = "complete"; op.provider_id = result.id; retrieve.mockResolvedValue({ ...result, id: "cus_other" });
  await expect(run()).rejects.toThrow("identity differs"); expect(create).not.toHaveBeenCalled();
});
test("step 8: missing request evidence and unavailable completion remain failures, not success", async () => {
  create.mockResolvedValueOnce({ id: result.id }); await expect(run()).rejects.toThrow("request evidence");
  rpc.mockImplementation(async name => name === "claim_monthly_mentorship_operation_v1" ? { data: op, error: null } : { data: null, error: { message: "Synthetic loss" } });
  await expect(run()).rejects.toThrow("completion could not be recorded");
});

test.each([undefined, NaN, Infinity, () => "not-json"])("step 8: non-JSON request value %p is rejected before any observation", async value => {
  request.params.bad = value; await expect(run()).rejects.toThrow("plain JSON");
  expect(observe).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});
test("step 8: a getter cannot execute while building the persisted request snapshot", async () => {
  const getter = jest.fn(() => "changed"); Object.defineProperty(request.params, "bad", { enumerable: true, get: getter });
  await expect(run()).rejects.toThrow("plain JSON"); expect(getter).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});
test("step 8: cyclic input cannot be silently reduced to a different request", async () => {
  request.params.self = request.params; await expect(run()).rejects.toThrow("plain JSON"); expect(create).not.toHaveBeenCalled();
});
test("step 8: an array hole plus a named property cannot masquerade as dense JSON", async () => {
  request.params.items = Object.assign(new Array(1), { extra: "not-an-index" });
  await expect(run()).rejects.toThrow("dense JSON"); expect(create).not.toHaveBeenCalled();
});
test("step 8: ordinary dense request arrays retain their exact content", async () => {
  request.params.items = [{ quantity: 1 }]; await run();
  expect(create.mock.calls[0][0].params.items).toEqual([{ quantity: 1 }]);
});

test.each(['missing','error','agreement','kind','scope','request','id','revision','time','review'])('existing-only %s evidence refuses before claim/provider activity',async issue=>{
  existingOnly=true;const saved={...op};
  if(issue==='agreement')saved.agreement_id=actorId;if(issue==='kind')saved.kind='product';if(issue==='scope')saved.scope_key='other';
  if(issue==='request')saved.request={...request,path:'/changed'};if(issue==='id')saved.id='not-an-id';if(issue==='revision')saved.agreement_revision=-1;
  if(issue==='time')saved.dispatched_at='invalid';if(issue==='review')saved.status='review_required';
  lookup.mockResolvedValue({data:issue==='missing'?null:saved,error:issue==='error'?{message:'unavailable'}:null});
  await expect(run()).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();expect(retrieve).not.toHaveBeenCalled();
});
test('existing-only uncertain retry retains the exact original operation key',async()=>{
  existingOnly=true;await run();expect(create).toHaveBeenCalledWith(request,{idempotencyKey:'creatornet-membership:'+operationId,maxNetworkRetries:0});
  expect(lookup.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
});
test.each(['id','revision','time','request','regression'])('claim %s drift cannot dispatch a replacement',async issue=>{
  existingOnly=true;const saved={...op};if(issue==='regression')saved.status='complete';lookup.mockResolvedValue({data:saved,error:null});
  if(issue==='id')op.id=actorId;if(issue==='revision')op.agreement_revision=1;if(issue==='time')op.dispatched_at='2000-01-01T00:00:00Z';
  if(issue==='request')op.request={...request,path:'/changed'};
  await expect(run()).rejects.toThrow();expect(create).not.toHaveBeenCalled();expect(retrieve).not.toHaveBeenCalled();
});
test('existing-only dispatched-to-complete race retrieves the same original',async()=>{
  existingOnly=true;lookup.mockResolvedValue({data:{...op},error:null});op.status='complete';op.provider_id=result.id;
  await run();expect(create).not.toHaveBeenCalled();expect(retrieve).toHaveBeenCalledWith(result.id);
});
test('existing-only completed historical revision remains recoverable after expiry',async()=>{
  existingOnly=true;currentRevision=10;op.status='complete';op.provider_id=result.id;op.agreement_revision=9;op.dispatched_at='2000-01-01T00:00:00Z';
  await run();expect(create).not.toHaveBeenCalled();expect(retrieve).toHaveBeenCalledWith(result.id);
});
test.each(['expired','revision'])('existing-only %s dispatch still requires reconciliation',async issue=>{
  existingOnly=true;if(issue==='expired')op.dispatched_at='2000-01-01T00:00:00Z';else op.agreement_revision=9;
  await expect(run()).rejects.toThrow('reconciliation');expect(create).not.toHaveBeenCalled();
});
