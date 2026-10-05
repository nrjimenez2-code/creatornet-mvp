import {createMockClient} from "./__mocks__/supabaseQueryMock";
import {attachOriginalProductCheckout} from "@/lib/productCheckoutAttachment";
import {calculateCreatorFees,creatorFeeMetadata} from "@/lib/money";
const fees=calculateCreatorFees(10000,{enabled:true,basisPoints:290,fixedCents:30,version:"saved"});
let attempt:any,order:any,session:any,purchase:any,issue:string;
const db=createMockClient(op=>{
 if(op.table==="product_checkout_attempts")return {data:attempt,error:null};
 if(op.table==="orders"&&op.kind==="select")return {data:order,error:null};
 if(op.table==="orders"&&op.kind==="update"){
  if(issue==="order race")return {data:null,error:null};
  order={...order,...op.payload as object};return {data:{id:order.id},error:null};
 }
 if(op.table==="purchases"&&op.kind==="insert"){
  if(issue==="pending error")return {data:null,error:{message:"lost database reply"}};
  if(purchase)return {data:null,error:{code:"23505"}};
  purchase={id:"purchase",...op.payload as object};return {data:{id:"purchase"},error:null};
 }
 if(op.table==="purchases"&&op.kind==="select")return {data:purchase,error:null};
 throw Error("Unexpected operation");
});
const run=()=>attachOriginalProductCheckout({admin:db as any,buyerId:"buyer",attemptId:"attempt",attemptKey:"key",session});
beforeEach(()=>{
 db.ops.length=0;issue="";purchase=null;
 const meta={buyer_id:"buyer",creator_id:"creator",product_id:"product",post_id:"post",order_id:"order",checkout_attempt_key:"key",...creatorFeeMetadata(fees)};
 session={id:"cs_original",status:"open",payment_status:"unpaid",amount_total:10000,currency:"usd",metadata:meta,payment_intent:null};
 attempt={id:"attempt",buyer_id:"buyer",creator_id:"creator",product_id:"product",order_id:"order",attempt_key:"key",stripe_checkout_session_id:"cs_original",
  original_request_protocol:"product-checkout-original-v1",original_request:{params:{metadata:meta,line_items:[{price_data:{unit_amount:10000}}]}}};
 order={id:"order",buyer_id:"buyer",creator_id:"creator",post_id:"post",amount_cents:10000,gross_amount:10000,
  platform_fee:fees.platformFeeCents,processing_fee:fees.processingFeeCents,total_creator_deduction:fees.totalCreatorDeductionCents,
  creator_amount:fees.creatorNetCents,fee_schedule_version:fees.feeScheduleVersion,status:"created",currency:"usd",stripe_checkout_session_id:null,stripe_payment_intent_id:null};
});
test("repairs original attachment and replays without creating another purchase or overwriting status",async()=>{
 await run();expect(order.stripe_checkout_session_id).toBe("cs_original");expect(purchase.session_id).toBe("cs_original");
 purchase.status="paid";await run();expect(purchase.status).toBe("paid");
 expect(db.ops.filter(op=>op.kind==="update").every(op=>op.table==="orders"&&op.filters.status==="created")).toBe(true);
 expect(db.ops.some(op=>op.table==="products"||op.kind==="delete")).toBe(false);
});
test("pending write failure preserves original order and retry uses the same session",async()=>{
 issue="pending error";await expect(run()).rejects.toThrow();expect(order.stripe_checkout_session_id).toBe("cs_original");
 issue="";await run();expect(purchase.session_id).toBe("cs_original");
});
test.each(["missing order","wrong buyer","fee drift","missing fees","order race","paid order","other session","other purchase","wrong binding","stop requested"])("%s cannot authorize a payable recovery",async problem=>{
 if(problem==="stop requested")attempt.original_stop_requested_at=new Date().toISOString();
 if(problem==="missing order")order=null;if(problem==="wrong buyer")order.buyer_id="other";
 if(problem==="fee drift")order.processing_fee++;if(problem==="missing fees")delete session.metadata.fee_schedule_version;
 if(problem==="order race")issue=problem;if(problem==="paid order")order.status="paid";
 if(problem==="other session")order.stripe_checkout_session_id="cs_other";
 if(problem==="other purchase")purchase={id:"other",session_id:"cs_other",order_id:"other",status:"pending"};
 if(problem==="wrong binding")attempt.stripe_checkout_session_id="cs_other";
 await expect(run()).rejects.toThrow();
 expect(db.ops.some(op=>op.table==="purchases"&&op.kind==="update")).toBe(false);
 expect(db.ops.some(op=>op.table==="orders"&&op.kind==="insert")).toBe(false);
});
