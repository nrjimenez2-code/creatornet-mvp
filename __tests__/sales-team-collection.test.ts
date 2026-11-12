/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import type {SupabaseClient} from "@supabase/supabase-js";
import type Stripe from "stripe";
import {readFileSync} from "node:fs";
import {salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "@/test-support/sales-team-sale-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {prepareTeamCollection,confirmTeamCollection,stopTeamCollection,readTeamCollection} from "@/lib/salesTeams/collection";
import {teamPaymentFixture} from "@/test-support/sales-team-payment-fixture";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,sale:string;const context=teamPaymentFixture().contract.context,evidence=teamPaymentFixture().evidence;
const json=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const rpc=async(name:string,args:Record<string,unknown>)=>{
 try{const keys=Object.keys(args);if(!/^[a-z_0-9]+$/.test(name)||keys.some(k=>!/^p_[a-z_]+$/.test(k)))throw Error("invalid fixture query");
  const result=await db.query<{r:unknown}>(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(",")}) r`,Object.values(args));return {data:json(result.rows[0].r),error:null};
 }catch(error){return {data:null,error};}
};
const admin={rpc,from:(table:string)=>{
 if(!["sales_team_provider_operations_v1","sales_team_payment_confirmations_v1"].includes(table))throw Error(table);
 const filters:Record<string,unknown>={};let columns="*";
 const chain={select:(value:string)=>{if(!/^[a-z_,*]+$/.test(value))throw Error(value);columns=value;return chain;},eq:(key:string,value:unknown)=>{if(!/^[a-z_]+$/.test(key))throw Error(key);filters[key]=value;return chain;},maybeSingle:async()=>{
  const result=await db.query(`select ${columns} from public.${table} where ${Object.keys(filters).map((k,i)=>`${k}=$${i+1}`).join(" and ")}`,Object.values(filters));return {data:result.rows[0]?json(result.rows[0]):null,error:null};}};return chain;
}} as unknown as SupabaseClient;
let customer:Record<string,unknown>|null,pi:Stripe.PaymentIntent|null,token:Stripe.ConfirmationToken,method:Stripe.PaymentMethod,failed:Stripe.Charge|null,outcome:string,timeoutPath:string|null,completeList:boolean;
const provider=jest.fn();let requestNumber=0;
const response=<T>(value:T):T=>json({...value,lastResponse:{requestId:`req_fixture${++requestNumber}`}});
const composition=()=>({admin,stripe:{rawRequest:provider as Stripe["rawRequest"]},context,observeContext:async()=>context,observeEvidence:async()=>evidence});
beforeAll(async()=>{
 db=await salesTeamSaleDatabase(createLocalPostgres(),{sharedAdmission:true});
 for(const name of ["20261021215909_sales_team_provider_journal_and_ledger.sql","20261021220845_sales_team_receipt_accounting.sql","20261022230849_sales_team_payment_collection.sql"])await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin");await enableTeamSalesFixture(db);const offer=await approveTeamOffer(db,[3]),draft=await draftTeamSale(db,offer.options.find(o=>o.kind==="installments")!.id);sale=draft.saleId;
 await rpc("accept_sales_team_sale_v1",{p_request_id:sale,p_buyer_id:id(10),p_fingerprint:draft.quote.fingerprint,p_accepted:true});await db.exec("update sales_team_controls_v1 set payment_collection_enabled=true");
 customer=null;pi=null;failed=null;requestNumber=0;outcome="succeeded";timeoutPath=null;completeList=true;provider.mockReset();
 const time=Math.floor(Date.now()/1000);token=json({...teamPaymentFixture("installments").token,created:time,expires_at:time+3600,payment_method_preview:{...teamPaymentFixture("installments").token.payment_method_preview!,card:{country:"US",exp_month:12,exp_year:2028,fingerprint:"fp_original",last4:"4242"}}}) as Stripe.ConfirmationToken;
 method={id:"pm_original",object:"payment_method",type:"card",customer:"cus_original",livemode:false,card:token.payment_method_preview!.card,billing_details:token.payment_method_preview!.billing_details} as Stripe.PaymentMethod;
 provider.mockImplementation(async(http:string,path:string,params:Record<string,unknown>={})=>{
  if(http==="POST"){
   if(path==="/v1/customers")customer={id:"cus_original",object:"customer",livemode:false,created:time,metadata:params.metadata};
   else if(path==="/v1/payment_intents")pi={...teamPaymentFixture("installments").pi,...params,id:"pi_original",object:"payment_intent",created:time,setup_future_usage:"off_session"} as Stripe.PaymentIntent;
   else if(path.endsWith("/confirm")){
    if(!pi)throw Error("missing intent");token.payment_intent=pi.id;token.expires_at=null;pi={...pi,status:outcome as Stripe.PaymentIntent.Status,payment_method:method.id,
     amount_received:outcome==="succeeded"?pi.amount:0,latest_charge:outcome==="succeeded"?"ch_paid":outcome==="requires_payment_method"?"ch_failed":null};
    if(outcome==="requires_payment_method")failed={id:"ch_failed",object:"charge",livemode:false,payment_intent:pi.id,customer:"cus_original",amount:pi.amount,currency:"usd",status:"failed",paid:false,captured:false,amount_captured:0} as Stripe.Charge;
   }else if(path.endsWith("/cancel")){if(!pi)throw Error("missing intent");pi={...pi,status:"canceled"};}
   else throw Error(path);
   if(path===timeoutPath)throw Error("uncertain response");return response(path==="/v1/customers"?customer:pi);
  }
  if(path==="/v1/customers")return response({data:customer?[customer]:[],has_more:!completeList});
  if(path==="/v1/customers/cus_original")return response(customer);
  if(path==="/v1/payment_intents")return response({data:pi?[pi]:[],has_more:!completeList});
  if(path==="/v1/payment_intents/pi_original")return response(pi);
  if(path==="/v1/confirmation_tokens/ctoken_original")return response(token);
  if(path==="/v1/payment_methods/pm_original")return response(method);
  if(path==="/v1/charges/ch_failed")return response(failed);
  throw Error(path);
 });
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
const posts=(path:string)=>provider.mock.calls.filter(([http,p])=>http==="POST"&&p===path);
const prepare=()=>prepareTeamCollection(composition(),sale,id(10),true);
const confirm=(request=id(70))=>confirmTeamCollection(composition(),sale,id(10),{requestId:request,kind:"token",tokenId:"ctoken_original"});
test("preparation and repeated loads retain the original customer and separate-charge intent",async()=>{
 expect((await prepare()).view.phase).toBe("needs_method");await prepare();expect(posts("/v1/customers")).toHaveLength(1);expect(posts("/v1/payment_intents")).toHaveLength(1);
 expect(posts("/v1/payment_intents")[0][2]).toMatchObject({confirm:false,confirmation_method:"manual",allowed_payment_method_types:["card"]});
 expect(posts("/v1/payment_intents")[0][2]).not.toHaveProperty("transfer_data");expect(JSON.stringify((await prepare()).view)).not.toMatch(/cus_original|acct_|client_secret/);
});
test("an uncertain customer creation is independently recovered without another POST",async()=>{
 timeoutPath="/v1/customers";await expect(prepare()).rejects.toThrow(/reconciliation/i);completeList=false;
 await expect(prepareTeamCollection(composition(),sale,id(10),false)).rejects.toThrow(/reconciliation/i);expect(posts("/v1/customers")).toHaveLength(1);
 completeList=true;await prepareTeamCollection(composition(),sale,id(10),false);expect(posts("/v1/customers")).toHaveLength(1);expect(posts("/v1/payment_intents")).toHaveLength(0);
});
test("an uncertain intent cannot be replaced or charged while its original list is incomplete",async()=>{
 timeoutPath="/v1/payment_intents";await expect(prepare()).rejects.toThrow(/reconciliation/i);completeList=false;await expect(prepare()).rejects.toThrow(/reconciliation/i);
 completeList=true;expect((await prepareTeamCollection(composition(),sale,id(10),false)).view.phase).toBe("needs_method");expect(posts("/v1/payment_intents")).toHaveLength(1);
});
test("captured money remains pending receipt and repeated confirmation never charges twice",async()=>{
 await prepare();expect((await confirm()).phase).toBe("captured_pending_receipt");expect((await confirm()).phase).toBe("captured_pending_receipt");
 expect(posts("/v1/payment_intents/pi_original/confirm")).toHaveLength(1);expect((await readTeamCollection(composition(),sale,id(10))).receipt).toBeNull();
});
test("an unknown confirmation is recovered from the independently used original token",async()=>{
 await prepare();timeoutPath="/v1/payment_intents/pi_original/confirm";await expect(confirm()).rejects.toThrow(/reconciliation/i);
 expect((await confirm()).phase).toBe("captured_pending_receipt");expect(posts("/v1/payment_intents/pi_original/confirm")).toHaveLength(1);
});
test("bank action requires server reconfirmation with the verified original card",async()=>{
 await prepare();outcome="requires_action";expect((await confirm()).phase).toBe("requires_action");pi={...pi!,status:"requires_confirmation"};
 expect((await prepareTeamCollection(composition(),sale,id(10),false)).view.phase).toBe("requires_confirmation");outcome="succeeded";
 expect((await confirmTeamCollection(composition(),sale,id(10),{requestId:id(71),kind:"reconfirm"})).phase).toBe("captured_pending_receipt");
 expect(posts("/v1/payment_intents/pi_original/confirm")).toHaveLength(2);expect(posts("/v1/payment_intents/pi_original/confirm")[1][2]).not.toHaveProperty("confirmation_token");
});
test("foreign billing or issuer evidence stops new confirmation before any provider POST",async()=>{
 await prepare();token.payment_method_preview!.card!.country="CA";await expect(confirm()).rejects.toThrow();expect(posts("/v1/payment_intents/pi_original/confirm")).toHaveLength(0);
});
test("Stop independently cancels an original unpaid intent and never reuses the closed admission",async()=>{
 await prepare();expect((await stopTeamCollection(composition(),sale,id(10))).phase).toBe("stopped");expect((await stopTeamCollection(composition(),sale,id(10))).phase).toBe("stopped");
 expect(posts("/v1/payment_intents/pi_original/cancel")).toHaveLength(1);expect((await prepare()).view.phase).toBe("stopped");expect(posts("/v1/payment_intents")).toHaveLength(1);
});
test("Stop after capture retains captured receipt recovery and cannot close the purchase unpaid",async()=>{
 await prepare();await confirm();expect((await stopTeamCollection(composition(),sale,id(10))).phase).toBe("captured_pending_receipt");
 expect((await readTeamCollection(composition(),sale,id(10))).closed).toBe(false);expect(posts("/v1/payment_intents/pi_original/cancel")).toHaveLength(0);
});
