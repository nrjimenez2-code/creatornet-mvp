/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from '@electric-sql/pglite';
import {installServerPaymentJournal} from '../test-support/server-payment-journal-postgres';
import {installMonthlyManualJournal} from '../test-support/monthly-manual-journal-postgres';
import {membershipFixture} from '../test-support/membership-fixtures';
import {membershipPayoffFixture} from '../test-support/membership-payoff-fixtures';
import {buildMembershipSubscription} from '@/lib/membershipCheckout';
import {buildMembershipManualContract} from '@/lib/membershipManualContract';
import {SERVER_PAYMENT_PROTOCOL,serverPaymentCreateRequest,type ServerPaymentContract} from '@/lib/serverPaymentConfirmation';
import {calculateCreatorFees,creatorFeeMetadata} from '@/lib/money';
import {stopServerPaymentIntent} from '@/lib/serverPaymentStop';
import {prepareServerPaymentIntent} from '@/lib/serverPaymentIntent';

declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
beforeAll(async()=>{db=createLocalPostgres();await installServerPaymentJournal(db);
  await installMonthlyManualJournal(db,{terminalRelease:true});});
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});
afterAll(async()=>{await db?.close();});
const copy=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
// PGlite runs outside Jest's VM; normalize JSON RPC values into this realm.
const scalar=async(name:string,args:unknown[])=>copy((await db.query<{r:any}>(`select to_jsonb(public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})) r`,args)).rows[0].r);
async function insert(table:string,value:Record<string,unknown>){
  const cols=Object.keys(value);await db.query(`insert into public.${table}(${cols.join(',')}) values(${cols.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(value));
}
async function fixture(kind:'first'|'payoff'='first'){
  const payoffBase=membershipPayoffFixture(false);
  const base=kind==='first'?membershipFixture():payoffBase,a=copy(base.a),payoff=payoffBase.p;
  if(kind==='first')a.stripe_checkout_session_id=null;
  Object.assign(a,{billing_review_at:null,initial_abandon_requested_at:null,initial_abandoned_at:null,payoff_hold_at:kind==='payoff'?new Date().toISOString():null});
  const ctx={version:'exact-payment-context-v1',mode:a.terms.paymentContext.mode,platformAccountId:a.terms.paymentContext.stripeAccountId,
    supabaseProjectRef:a.terms.paymentContext.supabaseProjectRef,siteOrigin:a.terms.paymentContext.siteOrigin};
  const evidence={approvedContext:ctx,vercelEnvironment:'preview',stripeSecretKeyMode:'test',stripePublishableKeyMode:'test',
    observedPlatformAccountId:ctx.platformAccountId,observedSupabaseProjectRef:ctx.supabaseProjectRef,
    configuredSupabaseUrl:`https://${ctx.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:ctx.siteOrigin};
  await db.query('insert into exact_installment_context_pin_v2 values(true,$1)',[ctx]);
  await db.query('insert into profiles values($1,null,false),($2,$3,true)',[a.buyer_id,a.creator_id,a.terms.destinationId]);
  await insert('monthly_mentorship_agreements_v1',a);
  if(kind==='first'){
    const requests={customer:{method:'POST',path:'/v1/customers',params:{}},product:{method:'POST',path:'/v1/products',params:{}},
      subscription:{method:'POST',path:'/v1/subscriptions',params:buildMembershipSubscription(a,base.customer.id,base.product.id)},
      hold:{method:'POST',path:'/v1/subscriptions/'+base.subscription.id,params:{pause_collection:{behavior:'keep_as_draft'}}}};
    for(const name of ['customer','product','subscription','hold'] as const)await insert('monthly_mentorship_operations_v1',{
      agreement_id:a.id,kind:name,scope_key:'initial',request:requests[name],status:'complete',
      provider_id:name==='customer'?base.customer.id:name==='product'?base.product.id:base.subscription.id});
  }else{
    payoff.status='accepted';payoff.checkout_request=null;payoff.checkout_dispatched_at=null;payoff.stripe_checkout_session_id=null;
    await insert('monthly_mentorship_payoffs_v1',{...payoff,amount_cents:payoff.terms.amountCents,remaining_months:payoff.terms.remainingMonths,
      first_unpaid_month:payoff.terms.firstUnpaidMonth,period_start:payoff.terms.periodStart,period_end:payoff.terms.periodEnd});
  }
  const selection=await scalar('select_monthly_manual_payment_v1',[a.id,a.buyer_id,a.terms.paymentContext,kind,kind==='payoff'?payoff.id:null]);
  const contract=buildMembershipManualContract({selection,agreement:a,contextEvidence:evidence,now:Math.floor(Date.now()/1000),customer:base.customer,
    ...(kind==='first'?{firstPreparation:{customerId:base.customer.id,productId:base.product.id,subscriptionId:base.subscription.id,subscription:base.subscription}}:{payoff})});
  const request=serverPaymentCreateRequest(contract,evidence);
  const rpc=(name:string,...args:unknown[])=>scalar(name,[selection.id,a.buyer_id,ctx,...args]);
  const register=()=>rpc('register_monthly_manual_source_v1');
  const claim=()=>rpc('claim_server_payment_intent_v1',contract,request);
  const provider=(op:any)=>({...request.params,id:'pi_monthly',object:'payment_intent',livemode:false,
    setup_future_usage:request.params.setup_future_usage??null,status:'requires_payment_method',
    created:Math.floor(Date.parse(op.first_dispatch_at)/1000),amount_received:0,amount_capturable:0,
    payment_method:null,latest_charge:null,last_payment_error:null,on_behalf_of:null,shipping:null,transfer_group:null});
  return {a,selection,ctx,evidence,contract,request,rpc,register,claim,provider};
}

test.each(['first','payoff'] as const)('%s uses actual TS compiler/request with one original manual journal',async kind=>{
  const f=await fixture(kind);await db.exec('set local role service_role');
  const registered=await f.register();expect(await f.register()).toEqual(registered);
  expect(registered).toMatchObject({attempt_id:f.selection.id,kind:'monthly_'+kind,reservation_id:null,source:f.selection});
  const claim=await f.claim();expect(claim.status).toBe('dispatch');expect(claim.operation.request).toEqual(f.request);
  expect((await f.claim()).status).toBe('busy');
  expect(await f.rpc('assert_server_payment_intent_dispatch_v1',claim.operation.lease_token)).toEqual(claim.operation);
  const bound=await f.rpc('bind_server_payment_intent_v1',claim.operation.lease_token,f.provider(claim.operation),'req_monthly');
  expect(await f.claim()).toEqual({status:'bound',operation:bound});
  await db.exec('reset role');
  expect((await db.query('select * from product_checkout_attempts')).rows).toHaveLength(0);
  expect((await db.query('select * from monthly_mentorship_receipts_v1')).rows).toHaveLength(0);
});
test('monthly first uses the shared intent adapter with one SQL identity and a bound read retry',async()=>{
  const f=await fixture();await f.register();
  const admin={rpc:jest.fn(async(name:string,args:Record<string,unknown>)=>{
    const entries=Object.entries(args);
    try{return {data:copy((await db.query<{r:any}>(`select public.${name}(${entries.map(([key],i)=>key+'=> $'+(i+1)).join(',')}) r`,
      entries.map(([,v])=>v))).rows[0].r),error:null};}
    catch(error){return {data:null,error};}
  })};
  let pi:any=null;
  const stripe={paymentIntents:{
    create:jest.fn(async(params:any,options:any)=>{
      expect(options.idempotencyKey).toMatch(/^cn-server-intent-v1:[a-f0-9-]{36}$/);
      pi={...params,id:'pi_monthly',object:'payment_intent',livemode:false,
        setup_future_usage:'off_session',automatic_payment_methods:{enabled:false},
        status:'requires_payment_method',created:Math.floor(Date.now()/1000),amount_received:0,amount_capturable:0,
        payment_method:null,latest_charge:null,last_payment_error:null,on_behalf_of:null,shipping:null,transfer_group:null};
      return {...pi,lastResponse:{requestId:'req_monthly'}};
    }),retrieve:jest.fn(async()=>copy(pi))}};
  const args={contract:f.contract,admin,stripe:stripe as unknown as Parameters<typeof prepareServerPaymentIntent>[0]['stripe'],
    contextEvidence:async()=>f.evidence,assertProviderSource:async()=>{},
    env:{CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:'true',CREATOR_SERVER_PAYMENT_INTENT_READY:'true'}};
  const first=await prepareServerPaymentIntent(args);
  expect(first).toMatchObject({status:'bound_unpublished',paymentIntentId:'pi_monthly',providerStatus:'requires_payment_method'});
  const original=(await db.query<any>('select * from server_payment_intent_operations_v1')).rows[0];
  expect(original.payment_intent_id).toBe('pi_monthly');
  expect(original.contract).toEqual(f.contract);expect(original.request).toEqual(f.request);
  expect(await prepareServerPaymentIntent(args)).toMatchObject({status:'bound_unpublished',paymentIntentId:'pi_monthly'});
  expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  expect((await db.query('select * from product_checkout_attempts')).rows).toHaveLength(0);
  expect((await db.query('select * from monthly_mentorship_receipts_v1')).rows).toHaveLength(0);
});

async function cancellationFixture(kind:'first'|'payoff'){
  const f=await fixture(kind);await f.register();const operation=(await f.claim()).operation;
  const pi:any={...f.provider(operation),next_action:null,canceled_at:null};
  await f.rpc('bind_server_payment_intent_v1',operation.lease_token,pi,'req_monthly');
  const admin={rpc:jest.fn(async(name:string,args:Record<string,unknown>)=>{
    const entries=Object.entries(args);
    try{return {data:copy((await db.query<{r:any}>(`select public.${name}(${entries.map(([key],i)=>key+'=> $'+(i+1)).join(',')}) r`,entries.map(([,v])=>v))).rows[0].r),error:null};}
    catch(error){return {data:null,error};}
  })};
  const stripe={paymentIntents:{retrieve:jest.fn(async()=>copy(pi)),create:jest.fn(),confirm:jest.fn(),
    cancel:jest.fn(async()=>{Object.assign(pi,{status:'canceled',canceled_at:Math.floor(Date.now()/1000),next_action:null});return copy(pi);})},
    charges:{list:jest.fn(async()=>({object:'list',data:[],has_more:false}))}};
  const args={contract:f.contract,binding:{paymentIntentId:pi.id,firstDispatchAt:Math.floor(Date.parse(operation.first_dispatch_at)/1000)},admin,
    stripe:stripe as unknown as Parameters<typeof stopServerPaymentIntent>[0]['stripe'],contextEvidence:async()=>f.evidence,
    env:{CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:'true',CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY:'true',CREATOR_SERVER_PAYMENT_CANCELLATION_READY:'true'}};
  return {...f,operation,pi,admin,stripe,args};
}
test.each(['first','payoff'] as const)('%s reuses concrete stop runtime and SQL, leaving selection and holds unreleased',async kind=>{
  const f=await cancellationFixture(kind);await db.exec('set local role service_role');
  const result=await stopServerPaymentIntent(f.args);
  expect(result).toMatchObject({status:'intent_canceled_unreleased',releaseAllowed:false,proof:{paymentIntentId:'pi_monthly',chargeIds:[]}});
  expect(f.admin.rpc.mock.calls[0][0]).toBe('request_server_payment_stop_v1');
  const assertIndex=f.admin.rpc.mock.calls.findIndex(([name])=>name==='assert_server_payment_cancellation_v1');
  expect(f.admin.rpc.mock.invocationCallOrder[assertIndex]).toBeLessThan(f.stripe.paymentIntents.cancel.mock.invocationCallOrder[0]);
  await stopServerPaymentIntent(f.args);expect(f.stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);
  expect(f.stripe.paymentIntents.create).not.toHaveBeenCalled();expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
  await db.exec('reset role');
  expect((await db.query('select * from monthly_manual_payment_selections_v1')).rows).toHaveLength(1);
  expect((await db.query('select * from monthly_mentorship_initial_closures_v1')).rows).toHaveLength(0);
  const a=(await db.query<any>('select * from monthly_mentorship_agreements_v1')).rows[0];
  expect(a.initial_abandoned_at).toBeNull();if(kind==='payoff')expect(a.payoff_hold_at).not.toBeNull();
});
test.each(['first','payoff'] as const)('%s lost cancellation reply recovers the original without another write',async kind=>{
  const f=await cancellationFixture(kind),cancel=f.stripe.paymentIntents.cancel.getMockImplementation()!;
  f.stripe.paymentIntents.cancel.mockImplementationOnce(async()=>{await cancel();throw Error('lost response');});
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:'intent_canceled_unreleased'});
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:'intent_canceled_unreleased'});
  expect(f.stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);
});
test.each(['first','payoff'] as const)('%s unknown cancellation retries only the saved cancellation request and key',async kind=>{
  const f=await cancellationFixture(kind);f.stripe.paymentIntents.cancel.mockRejectedValueOnce(Error('timeout'));
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:'reconciliation_required',releaseAllowed:false});
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:'busy',releaseAllowed:false});
  await db.exec("update server_payment_intent_cancellations_v1 set lease_until=clock_timestamp()-interval '1 second'");
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:'intent_canceled_unreleased'});
  expect(f.stripe.paymentIntents.cancel.mock.calls).toHaveLength(2);
  expect(f.stripe.paymentIntents.cancel.mock.calls[0]).toEqual(f.stripe.paymentIntents.cancel.mock.calls[1]);
});
test.each(['first','payoff'] as const)('%s unbound create cannot be treated as absent or canceled',async kind=>{
  const f=await fixture(kind);await f.register();await f.claim();await f.rpc('request_server_payment_stop_v1');
  expect(await f.rpc('claim_server_payment_cancellation_v1')).toEqual({status:'reconciliation_required',operation:null});
  expect((await db.query('select * from server_payment_intent_cancellations_v1')).rows).toHaveLength(0);
});
test.each(['first','payoff'] as const)('%s cancellation source remains readable after dispatch expiry and debit revocation',async kind=>{
  const f=await cancellationFixture(kind);await f.rpc('request_server_payment_stop_v1');
  await db.exec("update server_payment_intent_operations_v1 set first_dispatch_at=clock_timestamp()-interval '24 hours';update monthly_mentorship_agreements_v1 set debit_revoked_at=clock_timestamp(),revision=revision+1");
  expect(await f.rpc('read_server_payment_cancellation_source_v1')).toMatchObject({payment_intent_id:'pi_monthly',idempotency_key:f.operation.idempotency_key});
});
test.each(['first','payoff'] as const)('%s accounted intent refuses cancellation even if agreement accounting lags',async kind=>{
  const f=await cancellationFixture(kind);await db.query('insert into payment_fee_ledger values(null,$1)',[f.pi.id]);
  await expect(stopServerPaymentIntent(f.args)).rejects.toThrow();expect(f.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
});
test.each(['first','payoff'] as const)('%s paid provider evidence never becomes an unpaid terminal proof',async kind=>{
  const f=await cancellationFixture(kind);Object.assign(f.pi,{status:'succeeded',amount_received:f.contract.amountCents,latest_charge:'ch_paid',payment_method:'pm_paid'});
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:'reconciliation_required',releaseAllowed:false});
  expect(f.stripe.paymentIntents.cancel).not.toHaveBeenCalled();expect((await db.query('select * from server_payment_intent_terminal_v1')).rows).toHaveLength(0);
});
test.each(['first','payoff'] as const)('%s cancellation refuses a foreign owner before provider access',async kind=>{
  const f=await cancellationFixture(kind);f.args.contract={...f.args.contract,buyerId:f.a.creator_id};
  await expect(stopServerPaymentIntent(f.args)).rejects.toThrow();expect(f.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  expect(f.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
});
test('a frozen first selection can retire after complete provider closure before journal registration',async()=>{
  const f=await fixture();
  expect(await scalar('monthly_manual_first_unregistered_v1',[f.a.id])).toBe(true);
  await db.query('insert into purchases(id,monthly_mentorship_id,kind,access_granted,paid_count,status) values($1,$2,$3,$4,$5,$6)',
    [f.a.purchase_id,f.a.id,'monthly_mentorship_v1',false,0,'pending']);
  await db.query('update monthly_mentorship_agreements_v1 set initial_abandon_requested_at=clock_timestamp() where id=$1',[f.a.id]);
  await db.query('insert into monthly_mentorship_initial_closures_v1(agreement_id,kind,resource_id,status) values($1,$2,$3,$4)',
    [f.a.id,'cancel_subscription',f.contract.sourceMetadata.membership_subscription_id,'complete']);
  const proof={version:'monthly-initial-abandonment-proof-v1',paymentContext:f.a.terms.paymentContext,
    membershipId:f.a.id,neverPayable:false,checkoutSessionId:null,customerId:f.contract.customerId,
    subscriptionId:f.contract.sourceMetadata.membership_subscription_id,paymentIntents:[],charges:[],invoices:[],
    subscriptions:[{id:f.contract.sourceMetadata.membership_subscription_id,status:'canceled'}],checkouts:[],
    listsComplete:true,pendingInvoiceItemCount:0,readRequestIds:Array(6).fill('req_monthly')};
  expect(await scalar('complete_monthly_initial_abandonment_v1',[f.a.id,f.a.buyer_id,f.a.terms.paymentContext,proof])).toBe(true);
  expect((await db.query<any>('select status from purchases where id=$1',[f.a.purchase_id])).rows[0].status).toBe('canceled');
  await expect(f.register()).rejects.toThrow('closing or abandoned');
});
test('customer-only bootstrap needs six empty provider financial lists before release',async()=>{
  const f=await fixture();
  await db.exec("delete from monthly_mentorship_operations_v1 where kind in ('subscription','hold')");
  await db.query('update monthly_mentorship_agreements_v1 set stripe_customer_id=null,stripe_subscription_id=null where id=$1',[f.a.id]);
  await db.query('insert into purchases(id,monthly_mentorship_id,kind,access_granted,paid_count,status) values($1,$2,$3,$4,$5,$6)',
    [f.a.purchase_id,f.a.id,'monthly_mentorship_v1',false,0,'pending']);
  await db.query('update monthly_mentorship_agreements_v1 set initial_abandon_requested_at=clock_timestamp() where id=$1',[f.a.id]);
  const base={version:'monthly-initial-abandonment-proof-v1',paymentContext:f.a.terms.paymentContext,
    membershipId:f.a.id,neverPayable:true};
  await db.exec('savepoint missing_customer_lists');
  await expect(scalar('complete_monthly_initial_abandonment_v1',[f.a.id,f.a.buyer_id,f.a.terms.paymentContext,base])).rejects.toThrow('customer financial lists');
  await db.exec('rollback to savepoint missing_customer_lists');
  const proof={...base,customerOnly:true,customerId:f.contract.customerId,listsComplete:true,
    pendingInvoiceItemCount:0,readRequestIds:Array(6).fill('req_monthly'),paymentIntents:[],charges:[],invoices:[],
    subscriptions:[],checkouts:[]};
  await db.exec('savepoint nonempty_customer_lists');
  await expect(scalar('complete_monthly_initial_abandonment_v1',[f.a.id,f.a.buyer_id,f.a.terms.paymentContext,
    {...proof,paymentIntents:[{id:'pi_unknown'}]}])).rejects.toThrow('financial lists are not empty');
  await db.exec('rollback to savepoint nonempty_customer_lists');
  expect(await scalar('complete_monthly_initial_abandonment_v1',[f.a.id,f.a.buyer_id,f.a.terms.paymentContext,proof])).toBe(true);
});
test('manual first terminal joins the original stop, intent, customer and subscription before monthly close-out',async()=>{
  const f=await cancellationFixture('first');
  await db.exec('savepoint before_terminal');
  await expect(db.query('insert into monthly_mentorship_initial_closures_v1(agreement_id) values($1)',[f.a.id])).rejects.toThrow();
  await db.exec('rollback to savepoint before_terminal');
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:'intent_canceled_unreleased',releaseAllowed:false});
  const terminal=await scalar('monthly_manual_first_terminal_v1',[f.a.id]);
  expect(terminal).toMatchObject({attemptId:f.selection.id,paymentIntentId:f.pi.id,
    customerId:f.contract.customerId,subscriptionId:f.contract.sourceMetadata.membership_subscription_id,
    terminalProof:{status:'canceled',amountReceived:0,amountCapturable:0}});
  await db.query('insert into monthly_mentorship_initial_closures_v1(agreement_id,kind,resource_id,status) values($1,$2,$3,$4)',
    [f.a.id,'cancel_subscription',terminal.subscriptionId,'complete']);
  await db.query('insert into purchases(id,monthly_mentorship_id,kind,access_granted,paid_count,status) values($1,$2,$3,$4,$5,$6)',
    [f.a.purchase_id,f.a.id,'monthly_mentorship_v1',false,0,'pending']);
  const proof={version:'monthly-initial-abandonment-proof-v1',paymentContext:f.a.terms.paymentContext,
    membershipId:f.a.id,neverPayable:false,checkoutSessionId:null,customerId:terminal.customerId,
    subscriptionId:terminal.subscriptionId,paymentIntents:[{id:f.pi.id,status:'canceled',
      amountReceivedCents:0,amountCapturableCents:0}],charges:[],invoices:[],
    subscriptions:[{id:terminal.subscriptionId,status:'canceled'}],checkouts:[],
    listsComplete:true,pendingInvoiceItemCount:0,readRequestIds:Array(6).fill('req_monthly')};
  await db.query('update monthly_mentorship_agreements_v1 set initial_abandon_requested_at=clock_timestamp() where id=$1',[f.a.id]);
  expect(await scalar('complete_monthly_initial_abandonment_v1',[f.a.id,f.a.buyer_id,f.a.terms.paymentContext,proof])).toBe(true);
  expect((await db.query<any>('select initial_abandoned_at from monthly_mentorship_agreements_v1 where id=$1',[f.a.id])).rows[0].initial_abandoned_at).not.toBeNull();
  expect((await db.query<any>('select status from purchases where id=$1',[f.a.purchase_id])).rows[0].status).toBe('canceled');
  await db.exec('savepoint hosted_still_blocked');
  await expect(db.query("insert into monthly_mentorship_operations_v1(agreement_id,kind,scope_key,request,status) values($1,'checkout','initial','{}','pending')",[f.a.id])).rejects.toThrow();
  await db.exec('rollback to savepoint hosted_still_blocked');
});
test('manual terminal release refuses ledger activity and a fabricated early retirement',async()=>{
  const f=await cancellationFixture('first');
  const proof={version:'monthly-initial-abandonment-proof-v1',paymentContext:f.a.terms.paymentContext,
    membershipId:f.a.id,neverPayable:false,checkoutSessionId:null,customerId:f.contract.customerId,
    subscriptionId:f.contract.sourceMetadata.membership_subscription_id,paymentIntents:[{id:f.pi.id,status:'canceled',
      amountReceivedCents:0,amountCapturableCents:0}]};
  await db.exec('savepoint early_retirement');
  await expect(db.query('update monthly_mentorship_agreements_v1 set initial_abandon_requested_at=clock_timestamp(), initial_abandon_proof=$1, initial_abandoned_at=clock_timestamp() where id=$2',[proof,f.a.id])).rejects.toThrow();
  await db.exec('rollback to savepoint early_retirement');
  await stopServerPaymentIntent(f.args);
  await db.query('insert into payment_fee_ledger values($1,$2)',[f.a.purchase_id,f.pi.id]);
  expect(await scalar('monthly_manual_first_terminal_v1',[f.a.id])).toBeNull();
  await db.exec('savepoint ledger_release');
  await expect(db.query('insert into monthly_mentorship_initial_closures_v1(agreement_id) values($1)',[f.a.id])).rejects.toThrow();
  await db.exec('rollback to savepoint ledger_release');
});
test('a canceled intent alone cannot bypass the complete subscription and customer proof',async()=>{
  const f=await cancellationFixture('first');await stopServerPaymentIntent(f.args);
  await db.query('insert into purchases(id,monthly_mentorship_id,kind,access_granted,paid_count,status) values($1,$2,$3,$4,$5,$6)',
    [f.a.purchase_id,f.a.id,'monthly_mentorship_v1',false,0,'pending']);
  const incomplete={version:'monthly-initial-abandonment-proof-v1',paymentContext:f.a.terms.paymentContext,
    membershipId:f.a.id,neverPayable:false,checkoutSessionId:null,customerId:f.contract.customerId,
    subscriptionId:f.contract.sourceMetadata.membership_subscription_id,
    paymentIntents:[{id:f.pi.id,status:'canceled',amountReceivedCents:0,amountCapturableCents:0}]};
  await db.exec('savepoint incomplete_manual_release');
  await expect(db.query('update monthly_mentorship_agreements_v1 set initial_abandon_requested_at=clock_timestamp(),initial_abandon_proof=$1,initial_abandoned_at=clock_timestamp() where id=$2',[incomplete,f.a.id])).rejects.toThrow();
  await db.exec('rollback to savepoint incomplete_manual_release');
  expect((await db.query<any>('select initial_abandoned_at from monthly_mentorship_agreements_v1 where id=$1',[f.a.id])).rows[0].initial_abandoned_at).toBeNull();
});
test.each(['first','payoff'] as const)('%s confirmation uses the monthly return URL and refuses non-US basis',async kind=>{
  const f=await fixture(kind);await f.register();const op=(await f.claim()).operation,pi=f.provider(op);
  await f.rpc('bind_server_payment_intent_v1',op.lease_token,pi,'req_monthly');
  const now=Math.floor(Date.now()/1000),basis={kind:'token',token:{tokenId:'ctoken_monthly',createdAt:now,expiresAt:now+1800,previewHash:'b'.repeat(64),country:'US'}};
  await db.exec('savepoint foreign_country');
  await expect(f.rpc('claim_server_confirmation_v1',{...basis,token:{...basis.token,country:'CA'}},pi)).rejects.toThrow();
  await db.exec('rollback to savepoint foreign_country');
  const phase=(await f.rpc('claim_server_confirmation_v1',basis,pi)).operation;
  expect(phase.request.params).toEqual({confirmation_token:'ctoken_monthly',use_stripe_sdk:true,
    return_url:`${f.ctx.siteOrigin}/memberships/payment/return?attempt=${f.selection.id}`});
});
test.each(['first','payoff'] as const)('%s unknown retry retains original request, key and first dispatch time',async kind=>{
  const f=await fixture(kind);await f.register();const original=(await f.claim()).operation;
  await db.exec("update server_payment_intent_operations_v1 set lease_until=clock_timestamp()-interval '1 second'");
  const retry=(await f.claim()).operation;
  expect(retry.idempotency_key).toBe(original.idempotency_key);expect(retry.request).toEqual(original.request);
  expect(retry.first_dispatch_at).toBe(original.first_dispatch_at);expect(retry.lease_token).not.toBe(original.lease_token);
});
test.each(['amount','metadata','destination','setup','api','automatic','extra'] as const)('SQL independently rejects %s request drift',async fault=>{
  const f=await fixture();await f.register();const req:any=copy(f.request),c:any=copy(f.contract);
  if(fault==='amount'){c.amountCents++;req.params.amount++;}
  if(fault==='metadata')req.params.metadata.product_id='other';
  if(fault==='destination'){c.destinationId='acct_other';req.params.transfer_data.destination='acct_other';}
  if(fault==='setup')delete req.params.setup_future_usage;
  if(fault==='api')req.apiVersion='2020-08-27';
  if(fault==='automatic')req.params.confirmation_method='automatic';
  if(fault==='extra')c.newTerms=true;
  await expect(f.rpc('claim_server_payment_intent_v1',c,req)).rejects.toThrow();
});
test.each(['financial_hold_at','debit_revoked_at','billing_review_at','initial_abandon_requested_at','renewal_stopped_at','payoff_hold_at'] as const)
('fresh first debit is refused after %s; original provenance remains readable',async field=>{
  const f=await fixture();await f.register();await db.query(`update monthly_mentorship_agreements_v1 set ${field}=clock_timestamp() where id=$1`,[f.a.id]);
  expect(await f.rpc('read_server_payment_source_v1',false)).toMatchObject({attempt_id:f.selection.id});
  await expect(f.claim()).rejects.toThrow();
});
test('stop retains the bound original for reconciliation and closes new confirmation',async()=>{
  const f=await fixture();await f.register();const op=(await f.claim()).operation;
  await f.rpc('bind_server_payment_intent_v1',op.lease_token,f.provider(op),'req_monthly');
  expect(await f.rpc('request_server_payment_stop_v1')).toMatchObject({releaseAllowed:false});
  expect(await f.rpc('read_server_payment_intent_v1')).toMatchObject({payment_intent_id:'pi_monthly',idempotency_key:op.idempotency_key});
  await expect(f.rpc('validate_server_payment_contract_v1',f.contract,f.request)).rejects.toThrow();
});
test.each(['missing_hold','unknown_subscription','customer_drift','price_drift','bound_customer_drift','bound_subscription_drift'] as const)('first payment refuses %s preparation',async fault=>{
  const f=await fixture();await f.register();
  if(fault==='missing_hold')await db.exec("delete from monthly_mentorship_operations_v1 where kind='hold'");
  if(fault==='unknown_subscription')await db.exec("update monthly_mentorship_operations_v1 set status='dispatched' where kind='subscription'");
  if(fault==='customer_drift')await db.exec("update monthly_mentorship_operations_v1 set provider_id='cus_other' where kind='customer'");
  if(fault==='price_drift')await db.exec(`update monthly_mentorship_operations_v1 set request=jsonb_set(request,'{params,items,0,price_data,unit_amount}','11000') where kind='subscription'`);
  if(fault==='bound_customer_drift')await db.exec("update monthly_mentorship_agreements_v1 set stripe_customer_id='cus_other'");
  if(fault==='bound_subscription_drift')await db.exec("update monthly_mentorship_agreements_v1 set stripe_subscription_id='sub_other'");
  await expect(f.claim()).rejects.toThrow('preparation');
});
test('expired unknown original enters reconciliation without a fresh operation or key',async()=>{
  const f=await fixture();await f.register();const original=(await f.claim()).operation;
  await db.exec("update server_payment_intent_operations_v1 set first_dispatch_at=clock_timestamp()-interval '24 hours',lease_until=clock_timestamp()-interval '1 second'");
  const next=await f.claim();expect(next.status).toBe('reconciliation_required');
  expect(next.operation.idempotency_key).toBe(original.idempotency_key);expect(next.operation.request).toEqual(original.request);
});
test.each(['first','payoff'] as const)('%s cannot bind a different amount or replace an already bound intent',async kind=>{
  const f=await fixture(kind);await f.register();const op=(await f.claim()).operation,pi=f.provider(op);
  await db.exec('savepoint bad_bind');
  await expect(f.rpc('bind_server_payment_intent_v1',op.lease_token,{...pi,amount:f.contract.amountCents+1},'req_bad')).rejects.toThrow();
  await db.exec('rollback to savepoint bad_bind');
  await f.rpc('bind_server_payment_intent_v1',op.lease_token,pi,'req_monthly');
  await expect(f.rpc('bind_server_payment_intent_v1',op.lease_token,{...pi,id:'pi_replacement'},'req_other')).rejects.toThrow();
});

test.each(['full','first_installment'] as const)('preserved %s validator still admits and confirms the original request',async kind=>{
  const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const ctx={version:'exact-payment-context-v1' as const,mode:'test' as const,platformAccountId:'acct_owned',supabaseProjectRef:'abcdefghijklmnopqrst',siteOrigin:'https://fixture.vercel.app'};
  const evidence={approvedContext:ctx,vercelEnvironment:'preview',stripeSecretKeyMode:'test',stripePublishableKeyMode:'test',observedPlatformAccountId:ctx.platformAccountId,
    observedSupabaseProjectRef:ctx.supabaseProjectRef,configuredSupabaseUrl:`https://${ctx.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:ctx.siteOrigin};
  const schedule={enabled:true,basisPoints:290,fixedCents:30,version:'fixture-v1'},fees=calculateCreatorFees(3333,schedule),fingerprint='a'.repeat(64);
  const candidate={id:id(1),buyer_id:id(2),creator_id:id(3),product_id:id(4),post_id:id(5),purchase_identity:`post:${id(5)}`,
    attempt_key:id(6),order_id:id(7),terms_fingerprint:fingerprint,purchase_consent_id:id(8)};
  await db.query('insert into exact_installment_context_pin_v2 values(true,$1)',[ctx]);
  await db.query("insert into profiles values($1,'acct_creator',true)",[id(3)]);
  await db.query('insert into product_purchase_consents_v1(id,terms) values($1,$2)',[id(8),{kind:'one_time',buyerId:id(2),creatorId:id(3),productId:id(4),postId:id(5),amountCents:3333}]);
  await db.query("insert into orders values($1,$2,$3,$4,'created','usd',3333,3333,$5,$6,$7,$8,$9)",
    [id(7),id(2),id(3),id(5),fees.platformFeeCents,fees.processingFeeCents,fees.totalCreatorDeductionCents,fees.creatorNetCents,fees.feeScheduleVersion]);
  let created=Math.floor(Date.now()/1000),accepted=created;
  if(kind==='full'){
    const pin=await scalar('reserve_full_server_payment_v1',[candidate,id(2),ctx]);created=Math.floor(Date.parse(pin.created_at)/1000);
    accepted=Number((await db.query<{t:number}>('select floor(extract(epoch from accepted_at)) t from product_purchase_consents_v1')).rows[0].t);
  }else{
    await db.query(`insert into buyer_mentorship_installment_reservations_v1 values($1,$2,$3,$4,$5,$6,$7,$8,'reserved',null,to_timestamp($9),$10,$11,'acct_creator')`,
      [id(9),id(10),id(1),id(2),id(3),id(4),id(5),ctx,accepted,{payments:[{amountCents:3333}],firstPaymentFeeSchedule:schedule},fingerprint]);
    await insert('product_checkout_attempts',{...candidate,purchase_consent_id:null,checkout_kind:'installments',status:'creating',buyer_installment_reservation_id:id(9)});
    await scalar('pin_installment_server_payment_v1',[id(10),id(2),ctx]);
    await db.query("insert into buyer_mentorship_bootstraps_v1 values($1,'cus_owned',$2)",[id(9),created]);
    for(const step of ['subscription.create','subscription.hold'])await db.query("insert into buyer_mentorship_bootstrap_operations_v1 values($1,$2,$3,'sub_owned',clock_timestamp(),null)",
      [id(9),step,{params:{customer:'cus_owned'}}]);
  }
  const c:ServerPaymentContract={protocol:SERVER_PAYMENT_PROTOCOL,attemptId:id(1),buyerId:id(2),creatorId:id(3),productId:id(4),termsFingerprint:fingerprint,
    context:ctx,customerId:kind==='full'?null:'cus_owned',destinationId:'acct_creator',amountCents:3333,processingFees:schedule,kind,
    acceptedAt:accepted,expiresAt:created+86400-(kind==='full'?0:1860),sourceMetadata:{...creatorFeeMetadata(fees),buyer_id:id(2),creator_id:id(3),product_id:id(4),
      ...(kind==='full'?{order_id:id(7),checkout_attempt_key:id(6),checkout_terms_fingerprint:fingerprint}:{creatornet_installment_reservation_id:id(9),
        creatornet_installment_request_id:id(10),terms_fingerprint:fingerprint,installment_subscription_id:'sub_owned',installment_number:'1',plan_type:'installment'})}};
  const request=serverPaymentCreateRequest(c,evidence),rpc=(name:string,...tail:unknown[])=>scalar(name,[id(1),id(2),ctx,...tail]);
  await db.exec('set local role service_role');const op=(await rpc('claim_server_payment_intent_v1',c,request)).operation;
  const pi={...request.params,id:'pi_owned',object:'payment_intent',livemode:false,customer:c.customerId,setup_future_usage:kind==='full'?null:'off_session',
    status:'requires_payment_method',created:Math.floor(Date.parse(op.first_dispatch_at)/1000),amount_received:0,amount_capturable:0,
    payment_method:null,latest_charge:null,last_payment_error:null,on_behalf_of:null,shipping:null,transfer_group:null};
  await rpc('bind_server_payment_intent_v1',op.lease_token,pi,'req_owned');
  const now=Math.floor(Date.now()/1000),phase=await rpc('claim_server_confirmation_v1',{kind:'token',token:{tokenId:'ctoken_owned',createdAt:now,
    expiresAt:now+1800,previewHash:'c'.repeat(64),country:'US'}},pi);
  expect(phase.operation.request.params.return_url).toBe(`${ctx.siteOrigin}/purchase/payment/return?attempt=${id(1)}`);
});
test.each(['owner','context'] as const)('registration refuses wrong %s',async issue=>{
  const f=await fixture();await expect(scalar('register_monthly_manual_source_v1',[f.selection.id,issue==='owner'?f.a.creator_id:f.a.buyer_id,
    issue==='context'?{...f.ctx,platformAccountId:'acct_other'}:f.ctx])).rejects.toThrow();
});
test('abandonment request blocks a new journal registration while preserving the original',async()=>{
  const f=await fixture();
  await db.query('update monthly_mentorship_agreements_v1 set initial_abandon_requested_at=clock_timestamp() where id=$1',[f.a.id]);
  await db.exec('savepoint late_registration');
  await expect(f.register()).rejects.toThrow('closing or abandoned');
  await db.exec('rollback to savepoint late_registration');
  expect((await db.query<{count:string}>('select count(*) from server_payment_protocols_v1 where attempt_id=$1',[f.selection.id])).rows[0].count).toBe(0);

  await db.query('update monthly_mentorship_agreements_v1 set initial_abandon_requested_at=null where id=$1',[f.a.id]);
  const original=await f.register();
  await db.query('update monthly_mentorship_agreements_v1 set initial_abandon_requested_at=clock_timestamp() where id=$1',[f.a.id]);
  expect(await f.register()).toEqual(original);
  await expect(f.claim()).rejects.toThrow();
});
test.each(['first','payoff'] as const)('%s cannot register a new protocol after a billing review begins',async kind=>{
  const f=await fixture(kind);
  await db.query('update monthly_mentorship_agreements_v1 set billing_review_at=clock_timestamp() where id=$1',[f.a.id]);
  await db.exec('savepoint rejected_registration');
  await expect(f.register()).rejects.toThrow('changed or expired before registration');
  await db.exec('rollback to savepoint rejected_registration');
  expect((await db.query('select * from server_payment_protocols_v1 where attempt_id=$1',[f.selection.id])).rows).toHaveLength(0);
});
test('only service role can register; preserved private validators cannot be invoked directly',async()=>{
  const f=await fixture();
  for(const role of ['anon','authenticated','service_role']){
    await db.exec('savepoint role_test;set local role '+role);
    if(role!=='service_role'){
      await expect(f.register()).rejects.toThrow('permission denied');await db.exec('rollback to savepoint role_test;set local role '+role);
    }else expect(await f.register()).toMatchObject({attempt_id:f.selection.id});
    await expect(f.rpc('read_nonmonthly_server_payment_source_v1',false)).rejects.toThrow('permission denied');
    await db.exec('rollback to savepoint role_test');
  }
});
