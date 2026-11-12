/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {installStagingStructuralBaseline} from '../test-support/staging-catalog-postgres';
import {buildMembershipAgreement} from '@/lib/membershipAgreement';
import {readMembershipRecord} from '@/lib/membershipCheckout';
import {bootstrapRequests} from '../test-support/membership-checkout-recovery-fixtures';
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const buyer='14000000-0000-4000-8000-000000000001',creator='14000000-0000-4000-8000-000000000002';
const context={stripeAccountId:'acct_fixture',mode:'test' as const,apiVersion:'2025-10-29.clover',siteOrigin:'https://membership.example.invalid',supabaseProjectRef:'nwqfofezfzljhxolkycz'};
const sql=(p:string)=>readFileSync(join(process.cwd(),p),'utf8');
beforeAll(async()=>{
  db=createLocalPostgres();await installStagingStructuralBaseline(db);
  await db.exec(sql('supabase/schema/020-product-checkout-idempotency.sql'));
  await db.exec('create table public.exact_installment_agreements(id uuid primary key,terms jsonb); create table public.exact_installment_context_reservations_v2(id uuid primary key,terms jsonb)');
  const proposals=readdirSync(join(process.cwd(),'supabase/proposals')).filter(p=>/^075-|^0(?:7[789]|8[0-9])-/.test(p)).sort();
  for(const p of proposals)await db.exec(sql('supabase/proposals/'+p));
  await db.exec(sql('supabase/migrations/20260925052000_monthly_manual_payment_selection.sql'));
  await db.query('insert into auth.users(id) values($1),($2)',[buyer,creator]);
  await db.query("insert into public.profiles(id,username,stripe_account_id) values($1,'manual_buyer',null),($2,'manual_creator','acct_creator')",[buyer,creator]);
},30000);
afterAll(async()=>{await db?.close();});
async function membership(){
  const product=randomUUID(),post=randomUUID();
  const offer={id:product,creator_id:creator,type:'mentorship',title:'Monthly support',description:'Mentor questions',amount_cents:10000,price_cents:10000,currency:'usd',membership_terms:{version:'monthly-mentorship-v1',minimumMonths:3,autoRenew:true}};
  await db.query("insert into public.products(id,creator_id,title,description,type,price_cents,amount_cents,currency,plan_months,membership_terms) values($1,$2,$3,$4,'mentorship',10000,10000,'usd',1,$5::jsonb)",[product,creator,offer.title,offer.description,JSON.stringify(offer.membership_terms)]);
  await db.query("insert into public.posts(id,creator_id,product_id,title) values($1,$2,$3,'Monthly post')",[post,creator,product]);
  const quote=buildMembershipAgreement({offer,buyerId:buyer,postId:post,destinationId:'acct_creator',context,env:{}});
  const id=(await db.query<{id:string}>('select public.reserve_monthly_mentorship_v1($1,$2,$3,$4::jsonb,$5,true) id',[buyer,product,post,JSON.stringify(quote.agreement),quote.fingerprint])).rows[0].id;
  const select=async(kind='first',payoff:string|null=null,owner=buyer,ctx:unknown=context)=>
    (await db.query<{result:any}>('select public.select_monthly_manual_payment_v1($1,$2,$3::jsonb,$4,$5) result',[id,owner,JSON.stringify(ctx),kind,payoff])).rows[0].result;
  return {id,quote,select};
}
const hosted=(id:string)=>db.query("insert into public.monthly_mentorship_operations_v1(agreement_id,kind,scope_key,request,agreement_revision) values($1,'checkout','initial',$2::jsonb,0)",[id,JSON.stringify({method:'POST',path:'/v1/checkout/sessions',params:{synthetic:true}})]);

test('freezes accepted first-payment source without creating provider requests or granting access',async()=>{
  const m=await membership(),s=await m.select();
  expect(s).toMatchObject({agreement_id:m.id,buyer_id:buyer,kind:'first',payoff_id:null,protocol:'creatornet-us-manual-confirmation-v1',context,
    source:{agreementId:m.id,sourceFingerprint:m.quote.fingerprint,terms:m.quote.agreement,amountCents:10000,revision:0}});
  expect(s.source.expiresAt-s.source.acceptedAt).toBe(23*3600);expect(await m.select()).toEqual(s);
  expect((await db.query('select * from public.monthly_mentorship_operations_v1 where agreement_id=$1',[m.id])).rows).toHaveLength(0);
  expect((await db.query<{allowed:boolean}>('select (public.read_monthly_mentorship_entitlement_v1(purchase_id,buyer_id)->>\'allowed\')::boolean allowed from public.monthly_mentorship_agreements_v1 where id=$1',[m.id])).rows[0].allowed).toBe(false);
});
test('hosted admission first, including an unbound dispatched request, prevents manual adoption',async()=>{
  const m=await membership();await hosted(m.id);await expect(m.select()).rejects.toThrow('original recovery');
  expect((await db.query('select * from public.monthly_manual_payment_selections_v1 where agreement_id=$1',[m.id])).rows).toHaveLength(0);
});
test('manual selection first prevents hosted journal admission and publication',async()=>{
  const m=await membership();await m.select();await expect(hosted(m.id)).rejects.toThrow('own confirmation');
  await expect(db.query("update public.monthly_mentorship_agreements_v1 set stripe_checkout_session_id='cs_forbidden' where id=$1",[m.id])).rejects.toThrow('hosted publication');
});
test('manual first selection retains the original customer, product, subscription and hold journal',async()=>{
  const m=await membership(),selected=await m.select();
  const raw=(await db.query<{value:unknown}>(
    'select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1',[m.id])).rows[0].value;
  const a=readMembershipRecord(JSON.parse(JSON.stringify(raw)));
  const ids={customer:'cus_'+randomUUID().replaceAll('-',''),product:'prod_'+randomUUID().replaceAll('-',''),
    subscription:'sub_'+randomUUID().replaceAll('-','')};
  const requests=bootstrapRequests(a,ids);
  for(const kind of ['customer','product','subscription','hold'] as const){
    const claim=async()=>(await db.query<{value:{id:string;status:string;provider_id:string|null}}>(
      "select public.claim_monthly_mentorship_operation_v1($1,$2,$3,'initial',$4,$5::jsonb,$6::jsonb) value",
      [m.id,buyer,kind,a.revision,JSON.stringify(context),JSON.stringify(requests[kind])])).rows[0].value;
    const row=await claim();expect(row.provider_id).toBeNull();
    await db.query('select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,$3,$4)',
      [row.id,JSON.stringify(context),ids[kind==='hold'?'subscription':kind],'req_original']);
    expect((await claim()).id).toBe(row.id);
  }
  expect((await m.select()).id).toBe(selected.id);
  await expect(hosted(m.id)).rejects.toThrow('own confirmation');
  expect((await db.query<{stripe_checkout_session_id:string|null}>(
    'select stripe_checkout_session_id from public.monthly_mentorship_agreements_v1 where id=$1',[m.id]))
    .rows[0].stripe_checkout_session_id).toBeNull();
});
test('unselected legacy agreement retains hosted behavior',async()=>{
  const m=await membership();await expect(hosted(m.id)).resolves.toBeDefined();
});
test.each(['owner','context','kind','payoff_source'])('refuses mismatched %s without selecting',async fault=>{
  const m=await membership();await expect(m.select(fault==='kind'?'renewal':'first',fault==='payoff_source'?randomUUID():null,
    fault==='owner'?creator:buyer,fault==='context'?{...context,stripeAccountId:'acct_other'}:context)).rejects.toThrow();
  expect((await db.query('select * from public.monthly_manual_payment_selections_v1 where agreement_id=$1',[m.id])).rows).toHaveLength(0);
});
test.each(['financial_hold_at','debit_revoked_at','renewal_stopped_at','initial_abandon_requested_at'])('refuses fresh source with %s',async field=>{
  const m=await membership();await db.query(`update public.monthly_mentorship_agreements_v1 set ${field}=clock_timestamp() where id=$1`,[m.id]);
  await expect(m.select()).rejects.toThrow();
});
test('expired acceptance cannot be assigned a fresh manual identity or window',async()=>{
  const m=await membership();await db.query("update public.monthly_mentorship_agreements_v1 set accepted_at=clock_timestamp()-interval '24 hours' where id=$1",[m.id]);
  await expect(m.select()).rejects.toThrow('expired');
});
test('existing selected provenance survives a stop without renewing its timestamps',async()=>{
  const m=await membership(),s=await m.select();await db.query('update public.monthly_mentorship_agreements_v1 set debit_revoked_at=clock_timestamp() where id=$1',[m.id]);
  expect(await m.select()).toEqual(s);
});
test('selection and source terms are immutable, while stops remain writable',async()=>{
  const m=await membership(),s=await m.select();
  await expect(db.query('delete from public.monthly_manual_payment_selections_v1 where id=$1',[s.id])).rejects.toThrow('immutable');
  await expect(db.query('update public.monthly_manual_payment_selections_v1 set selected_at=clock_timestamp() where id=$1',[s.id])).rejects.toThrow('immutable');
  await expect(db.query('update public.monthly_mentorship_agreements_v1 set monthly_price_cents=12000 where id=$1',[m.id])).rejects.toThrow('terms cannot change');
  await expect(db.query('delete from public.monthly_mentorship_agreements_v1 where id=$1',[m.id])).rejects.toThrow('cannot be deleted');
  await db.query('update public.monthly_mentorship_agreements_v1 set financial_hold_at=clock_timestamp() where id=$1',[m.id]);
});
test('legacy initial close-out cannot erase or stop a selected manual source without its own proof',async()=>{
  const m=await membership();await m.select();
  await expect(db.query("insert into public.monthly_mentorship_initial_closures_v1(agreement_id,kind,resource_id,request,admission_proof) values($1,'cancel_subscription','sub_synthetic','{}','{}')",[m.id])).rejects.toThrow('own confirmation');
});
async function payoff(){
  const m=await membership(),id=randomUUID(),start=Math.floor(Date.now()/1000),end=start+60*86400;
  // Structural source fixture only: no fabricated hosted receipt or admission.
  await db.query('update public.monthly_mentorship_agreements_v1 set anchor_at=$2,covered_months=1,payoff_hold_at=clock_timestamp() where id=$1',[m.id,start]);
  const terms={paymentContext:context,syntheticLocalFixture:true};
  await db.query('insert into public.monthly_mentorship_payoffs_v1(id,agreement_id,buyer_id,terms,fingerprint,amount_cents,remaining_months,first_unpaid_month,period_start,period_end) values($1,$2,$3,$4::jsonb,$5,20000,2,2,$6,$7)',[id,m.id,buyer,JSON.stringify(terms),'a'.repeat(64),start,end]);
  return {...m,payoffId:id};
}
test('payoff selection binds the existing separately accepted source and excludes hosted dispatch',async()=>{
  const m=await payoff(),s=await m.select('payoff',m.payoffId);
  expect(s).toMatchObject({kind:'payoff',payoff_id:m.payoffId,source:{amountCents:20000,sourceFingerprint:'a'.repeat(64)}});
  await expect(db.query("update public.monthly_mentorship_payoffs_v1 set checkout_request='{}' where id=$1",[m.payoffId])).rejects.toThrow('own confirmation');
  await expect(db.query("update public.monthly_mentorship_payoffs_v1 set status='abandoned',abandoned_at=clock_timestamp(),abandonment_proof='{}' where id=$1",[m.payoffId])).rejects.toThrow('own confirmation');
  expect(await m.select('payoff',m.payoffId)).toEqual(s);
});
test('payoff with an original request cannot be adopted even when no provider ID was returned',async()=>{
  const m=await payoff();await db.query("update public.monthly_mentorship_payoffs_v1 set checkout_request='{}',checkout_dispatched_at=clock_timestamp(),status='checkout_dispatched' where id=$1",[m.payoffId]);
  await expect(m.select('payoff',m.payoffId)).rejects.toThrow('original recovery');
});
test('client roles cannot read or write selections or execute the private selector',async()=>{
  const m=await membership();
  for(const role of ['anon','authenticated']){
    await db.exec('set role '+role);
    try{
      await expect(m.select()).rejects.toThrow('permission denied');
      await expect(db.query('select * from public.monthly_manual_payment_selections_v1')).rejects.toThrow('permission denied');
    }finally{await db.exec('reset role');}
  }
  await db.exec('set role service_role');
  try{
    await expect(m.select()).resolves.toMatchObject({agreement_id:m.id});
    await expect(db.query('delete from public.monthly_manual_payment_selections_v1')).rejects.toThrow('permission denied');
  }finally{await db.exec('reset role');}
});
