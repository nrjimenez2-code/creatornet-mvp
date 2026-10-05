import type {SupabaseClient} from "@supabase/supabase-js";
import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {acknowledgeFullRefundReview,parseRefundReviewAcknowledgement} from "../lib/fullRefundReviewAcknowledgement";
const context=buyerFirstCaptureFixture().context;
const env=Object.fromEntries(["CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY","CREATOR_FULL_REFUND_REVIEW_SCHEMA_READY","CREATOR_FULL_REFUND_REVIEW_ADMIN_SCHEMA_READY",
  "CREATOR_FULL_REFUND_REVIEW_ADMIN_READY","CREATOR_FULL_REFUND_REVIEW_ACK_SCHEMA_READY","CREATOR_FULL_REFUND_REVIEW_ACK_READY"].map(k=>[k,"true"]));
const actor="10000000-0000-4000-8000-000000000001",input={requestId:"10000000-0000-4000-8000-000000000002",eventId:"evt_original",revision:3,confirmHoldRetained:true as const};
test.each([{...input,confirmHoldRetained:false},{...input,revision:-1},{...input,revision:0.1},{...input,actorId:actor},{...input,eventId:"bad"}])("rejects malformed or unconfirmed review %p",v=>{expect(parseRefundReviewAcknowledgement(v)).toBeNull();});
test.each(Object.keys(env))("%s disabled prevents writes",async key=>{
  const rpc=jest.fn(),observe=jest.fn();await expect(acknowledgeFullRefundReview({rpc} as unknown as SupabaseClient,actor,input,{...env,[key]:"false"},{context,observe})).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();
});
test("exact operator request returns only acknowledged hold-retaining status and context failures remain uncertain",async()=>{
  const data={status:"review_recorded_hold_retained",...input,recordedAt:"2026-09-23T06:00:00Z",current:false,secret:"private"};
  const rpc=jest.fn().mockResolvedValue({data,error:null}),observe=jest.fn().mockResolvedValue(context);
  const run=()=>acknowledgeFullRefundReview({rpc} as unknown as SupabaseClient,actor,input,env,{context,observe});
  expect(await run()).toEqual({status:"review_recorded_hold_retained",current:false});
  expect(rpc).toHaveBeenCalledWith("acknowledge_full_refund_review_v1",{p_context:context,p_actor_id:actor,p_request_id:input.requestId,p_event_id:input.eventId,p_revision:3});
  observe.mockResolvedValueOnce(context).mockRejectedValueOnce(Error("changed"));await expect(run()).rejects.toThrow("changed");
  rpc.mockResolvedValue({data:{...data,revision:4},error:null});await expect(run()).rejects.toThrow();
});
