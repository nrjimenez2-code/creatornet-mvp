/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "@/test-support/sales-team-sale-postgres";
import {teamFixtureId as id,teamRpc as manage} from "@/test-support/sales-team-postgres";
import {recipientCreationRequest,recipientLinkRequest,type TeamRecipientSetup} from "@/lib/salesTeams/recipientPolicy";
import {teamOperationId} from "@/lib/salesTeams/providerOperation";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,member:string;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
async function rpc<T=Record<string,unknown>>(name:string,args:unknown[]=[]):Promise<T>{return (await db.query<{r:T}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) r`,args)).rows[0].r;}
const reserve=(create=false,user=2)=>rpc<TeamRecipientSetup|null>("reserve_sales_team_recipient_v1",[id(user),context,create]);
const observation=(account="acct_original",request="req_verified")=>({accountId:account,country:"US",currency:"usd",transfersActive:true,payoutsReady:true,ownershipVerified:true,requestId:request,api:"v1"});
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
beforeAll(async()=>{
 db=await salesTeamSaleDatabase(createLocalPostgres());
 await db.exec(`create table public.profiles(id uuid primary key,stripe_account_id text);
  insert into public.profiles(id) select id from auth.users;
  create table public.stripe_connect_account_creations(creator_id uuid primary key,idempotency_key uuid unique not null default gen_random_uuid(),email text,created_at timestamptz not null default now(),stripe_account_id text);
  grant select,insert,update on public.profiles,public.stripe_connect_account_creations to service_role;`);
 await db.exec(readFileSync("supabase/migrations/20261021215909_sales_team_provider_journal_and_ledger.sql","utf8"));
 await db.exec(readFileSync("supabase/migrations/20261022223942_sales_team_recipient_onboarding.sql","utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin");member=await enableTeamSalesFixture(db);
 await db.query("delete from public.sales_team_recipients_v1 where user_id=$1",[id(2)]);
 await db.exec("update public.sales_team_controls_v1 set recipient_onboarding_enabled=true");
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
async function legacy(account:string|null="acct_original"){
 await db.query("insert into public.stripe_connect_account_creations(creator_id,idempotency_key,stripe_account_id) values($1,$2,$3)",[id(2),id(50),account]);
 return reserve();
}
test("read-only refresh cannot reserve new creation; new recipient admission is independently default-off",async()=>{
 expect(await reserve()).toBeNull();
 await db.exec("update public.sales_team_controls_v1 set recipient_onboarding_enabled=false");
 await denied(()=>reserve(true),/TEAM_RECIPIENT_SETUP_HELD/);
 expect((await db.query("select count(*)::int n from sales_team_recipient_setups_v1")).rows).toEqual([{n:0}]);
});
test("legacy ownership reuses its original identity without new-activity or onboarding admission",async()=>{
 await db.exec("update public.sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false,recipient_onboarding_enabled=false");
 const first=await legacy();expect(first).toMatchObject({api:"v1",account_id:"acct_original",legacy_creation_key:id(50),request:null});
 expect(await reserve()).toEqual(first);
 await rpc("record_sales_team_recipient_v1",[id(2),context,observation()]);
 expect((await db.query("select account_id,transfers_active,payouts_ready from sales_team_recipients_v1 where user_id=$1",[id(2)])).rows).toEqual([{account_id:"acct_original",transfers_active:true,payouts_ready:true}]);
});
test("uncertain original legacy creation cannot be replaced with a v2 account",async()=>{
 await denied(()=>legacy(null),/ORIGINAL_CONNECT_RECOVERY_REQUIRED/);
 expect(await reserve()).toBeNull(); // The failed insertion was rolled back with the savepoint.
 await db.query("insert into public.stripe_connect_account_creations(creator_id,stripe_account_id) values($1,null)",[id(2)]);
 await denied(()=>reserve(true),/ORIGINAL_CONNECT_RECOVERY_REQUIRED/);
});
test("an editable profile link is not account ownership proof",async()=>{
 await db.query("update public.profiles set stripe_account_id='acct_unproven' where id=$1",[id(2)]);
 await denied(()=>reserve(true),/TEAM_RECIPIENT_IDENTITY_CONFLICT/);
});
test("new v2 setup freezes request parameters and fences legacy account creation",async()=>{
 const setup=(await reserve(true))!;expect(setup.api).toBe("v2");expect(setup.request).toEqual(recipientCreationRequest(id(2),setup.id,"user2@example.test"));
 expect(await reserve(true)).toEqual(setup);
 await denied(()=>db.query("insert into stripe_connect_account_creations(creator_id) values($1)",[id(2)]),/TEAM_RECIPIENT_ALREADY_RESERVED/);
 await denied(()=>db.query("update sales_team_recipient_setups_v1 set request='{}' where user_id=$1",[id(2)]),/ORIGINAL_RECIPIENT_SETUP_CHANGED/);
 expect(await rpc("sales_team_recipient_continuation_v1",[id(2)])).toBe(false);
});
test("recipient recording requires the original bound operation and retains immutable capability observations",async()=>{
 const setup=(await reserve(true))!,proof={...observation("acct_new"),api:"v2"};
 await denied(()=>rpc("record_sales_team_recipient_v1",[id(2),context,proof]),/TEAM_RECIPIENT_PROOF_INVALID/);
 const scope={scopeId:id(2),scopeKey:`recipient:${setup.id}`,kind:"recipient" as const,saleId:null,creatorId:null,actorId:id(2),workerRunId:null},operationId=teamOperationId(scope);
 expect(await rpc("claim_sales_team_provider_operation_v1",[operationId,scope,context,setup.request])).toMatchObject({status:"dispatch"});
 expect(await rpc("sales_team_recipient_continuation_v1",[id(2)])).toBe(true);
 await rpc("bind_sales_team_provider_operation_v1",[operationId,"acct_new","req_created",false]);
 await rpc("record_sales_team_recipient_v1",[id(2),context,proof]);
 await rpc("record_sales_team_recipient_v1",[id(2),context,proof]);
 await denied(()=>rpc("record_sales_team_recipient_v1",[id(2),context,{...proof,payoutsReady:false}]),/TEAM_RECIPIENT_PROOF_INVALID/);
 await rpc("record_sales_team_recipient_v1",[id(2),context,{...proof,requestId:"req_restricted",payoutsReady:false}]);
 expect((await db.query("select count(*)::int n from sales_team_recipient_observations_v1")).rows).toEqual([{n:2}]);
 expect(await rpc("sales_team_member_ready_v1",[member])).toBe(false);
});
test("removed closers retain recovery for accepted sales but lose new routing",async()=>{
 await legacy();await rpc("record_sales_team_recipient_v1",[id(2),context,observation()]);
 const offer=await approveTeamOffer(db),draft=await draftTeamSale(db,offer.options[0].id);
 await rpc("accept_sales_team_sale_v1",[draft.saleId,id(10),draft.quote.fingerprint,true]);
 await manage(db,1,"remove_member",{membership_id:member});
 await db.exec("update public.sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false,recipient_onboarding_enabled=false");
 expect(await rpc("sales_team_recipient_allowed_v1",[id(2)])).toBe(true);
 expect(await rpc("sales_team_recipient_continuation_v1",[id(2)])).toBe(true);
 expect(await reserve()).toMatchObject({account_id:"acct_original"});
 await rpc("record_sales_team_recipient_v1",[id(2),context,{...observation(),requestId:"req_afterRemoval"}]);
 expect(await rpc("sales_team_member_ready_v1",[member])).toBe(false);
});
test("a removed member without an accepted obligation cannot use payout recovery",async()=>{
 await manage(db,1,"remove_member",{membership_id:member});
 expect(await rpc("sales_team_recipient_allowed_v1",[id(2)])).toBe(false);
 await denied(()=>reserve(true),/TEAM_RECIPIENT_SETUP_HELD/);
});
test("cross-user accounts, changed context and nonboolean capability proof cannot replace ownership",async()=>{
 await legacy();await rpc("record_sales_team_recipient_v1",[id(2),context,observation()]);
 await denied(()=>rpc("record_sales_team_recipient_v1",[id(3),context,observation()]),/TEAM_RECIPIENT_PROOF_INVALID/);
 await denied(()=>rpc("record_sales_team_recipient_v1",[id(2),{...context,platformAccountId:"acct_other"},observation()]),/TEAM_RECIPIENT_PROOF_INVALID/);
 await denied(()=>rpc("record_sales_team_recipient_v1",[id(2),context,{...observation(),payoutsReady:"true"}]),/TEAM_RECIPIENT_PROOF_INVALID/);
 await denied(()=>rpc("record_sales_team_recipient_v1",[id(2),context,{...observation("acct_other"),requestId:"req_changed"}]),/TEAM_RECIPIENT_IDENTITY_CONFLICT/);
 expect((await db.query("select account_id from sales_team_recipients_v1 where user_id=$1",[id(2)])).rows).toEqual([{account_id:"acct_original"}]);
});
test("successful link binding reuses its saved URL and never manufactures a provider object ID",async()=>{
 const setup=(await legacy())!,request=recipientLinkRequest(setup);
 const claim=await rpc<{link:{lease_token:string}}>("claim_sales_team_onboarding_link_v1",[id(2),id(60),context,request]);
 const expires=new Date(Date.now()+300000).toISOString();
 await rpc("bind_sales_team_onboarding_link_v1",[id(2),id(60),claim.link.lease_token,"https://connect.stripe.com/setup/synthetic",expires,"req_link"]);
 expect(await rpc("claim_sales_team_onboarding_link_v1",[id(2),id(60),context,request])).toMatchObject({status:"bound",link:{id:id(60),url:"https://connect.stripe.com/setup/synthetic",provider_request_id:"req_link"}});
});
test("a changed approved account pin or future verification cannot carry cached routing readiness",async()=>{
 await legacy();await rpc("record_sales_team_recipient_v1",[id(2),context,observation()]);
 expect(await rpc("sales_team_member_ready_v1",[member])).toBe(true);
 await db.query("update sales_team_recipients_v1 set verified_at=clock_timestamp()+interval '1 hour' where user_id=$1",[id(2)]);
 expect(await rpc("sales_team_member_ready_v1",[member])).toBe(false);
 await db.query("update sales_team_recipients_v1 set verified_at=clock_timestamp() where user_id=$1",[id(2)]);
 await db.query("update sales_team_financial_config_v1 set context=$1",[{...context,platformAccountId:"acct_changed"}]);
 expect(await rpc("sales_team_recipient_context_current_v1",[id(2)])).toBe(false);
 expect(await rpc("sales_team_member_ready_v1",[member])).toBe(false);
});
test("hosted links retain original request identities and refuse uncertain replacement or foreign URLs",async()=>{
 const setup=(await legacy())!,request=recipientLinkRequest(setup);
 expect(await rpc("claim_sales_team_onboarding_link_v1",[id(2),id(60),context,request])).toMatchObject({status:"dispatch"});
 const claim=await rpc<{status:string;link:{lease_token:string}}>("claim_sales_team_onboarding_link_v1",[id(2),id(60),context,request]);expect(claim.status).toBe("busy");
 await denied(()=>rpc("claim_sales_team_onboarding_link_v1",[id(2),id(60),context,{...request,params:{...request.params,return_url:"https://attacker.test"}}]),/ORIGINAL_PROVIDER_REQUEST_CHANGED/);
 await rpc("mark_sales_team_onboarding_unknown_v1",[id(2),id(60),claim.link.lease_token]);
 expect(await rpc("claim_sales_team_onboarding_link_v1",[id(2),id(60),context,request])).toMatchObject({status:"reconciliation_required"});
 await denied(()=>rpc("claim_sales_team_onboarding_link_v1",[id(2),id(61),context,request]),/ORIGINAL_ONBOARDING_LINK_NEEDS_REVIEW/);
 expect((await db.query("select count(*)::int n from sales_team_onboarding_links_v1")).rows).toEqual([{n:1}]);
});
test("first onboarding requests also reject foreign return URLs and expired dispatch leases",async()=>{
 const setup=(await legacy())!,request=recipientLinkRequest(setup);
 await denied(()=>rpc("claim_sales_team_onboarding_link_v1",[id(2),id(60),context,{...request,params:{...request.params,return_url:"https://attacker.test"}}]),/TEAM_RECIPIENT_PROOF_INVALID/);
 const claim=await rpc<{link:{lease_token:string}}>("claim_sales_team_onboarding_link_v1",[id(2),id(60),context,request]);
 await db.exec("update sales_team_onboarding_links_v1 set lease_until=clock_timestamp()-interval '1 second'");
 await denied(()=>rpc("assert_sales_team_onboarding_dispatch_v1",[id(2),id(60),claim.link.lease_token]),/TEAM_RECIPIENT_SETUP_HELD/);
});
test.each(["anon","authenticated"])("%s cannot read recipient identities, setup URLs or invoke recipient RPCs",async role=>{
 await legacy();await db.exec(`set local role ${role}`);
 for(const table of ["sales_team_recipient_setups_v1","sales_team_onboarding_links_v1","sales_team_recipient_observations_v1"])
  await denied(()=>db.exec(`select * from ${table}`),/permission denied/);
 await denied(()=>reserve(true),/permission denied/);
 await denied(()=>rpc("sales_team_recipient_continuation_v1",[id(2)]),/permission denied/);
});
