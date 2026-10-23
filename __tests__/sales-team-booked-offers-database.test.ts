/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale,teamSaleBooking} from "@/test-support/sales-team-sale-postgres";
import {teamFixtureId as id,addTeamMember} from "@/test-support/sales-team-postgres";
import {captureRpc as rpc,seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamSharedDatabase} from "@/test-support/sales-team-shared-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {inspectTeamReceiptFinancials} from "@/lib/salesTeams/financialChecks";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
async function installComposerGuard(target:PGlite){
 await target.exec("alter table posts add column if not exists video_action text,add column if not exists action_version integer default 0,add column if not exists offering_id uuid,add column if not exists booking_url text,add column if not exists booking_url_override text,add column if not exists tips_enabled boolean default false,add column if not exists premium_path text,add column if not exists cta_type text,add column if not exists price_cents integer default 0;grant select,insert,update on posts to service_role");
 await target.exec("update posts set video_action='buy',allow_booking=false where product_id is not null");
 const delivery=readFileSync("supabase/migrations/20260930175120_composer_premium_delivery.sql","utf8"),start=delivery.indexOf("create function public.guard_published_video_action_v1()"),end=delivery.indexOf("for each row execute function public.guard_published_video_action_v1();",start);
 if(start<0||end<0)throw Error("Actual composer guard dependency differs");await target.exec(delivery.slice(start,end+"for each row execute function public.guard_published_video_action_v1();".length));
}
beforeAll(async()=>{
 db=await salesTeamSaleDatabase(createLocalPostgres());await installComposerGuard(db);
 await db.exec(readFileSync("supabase/migrations/20261023010604_sales_team_booked_offer_associations.sql","utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin");
 await db.query("insert into posts(id,creator_id,allow_booking,video_action,action_version,booking_url) values($1,$2,true,'book',1,'https://calendar.example/original')",[id(22),id(1)]);
 await db.query("update bookings set post_id=$1 where id=$2",[id(22),teamSaleBooking]);
 await enableTeamSalesFixture(db);await db.exec("update sales_team_controls_v1 set booked_offer_associations_enabled=true");
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
const change=(attached=true,revision=0,request=id(25),actor=1,booking=teamSaleBooking,product=id(21))=>rpc<{revision:number;attached:boolean}>(db,"manage_sales_team_booked_offer_v1",[id(1),id(actor),booking,product,request,revision,attached]);
test("actual composer guard keeps Book exclusive while a separate offer enables approved checkout",async()=>{
 await denied(()=>db.query("insert into posts(id,creator_id,allow_booking,video_action,action_version,booking_url,product_id) values($1,$2,true,'book',1,'https://calendar.example/original',$3)",[id(23),id(1),id(21)]),/Conflicting video buttons/);
 await denied(()=>approveTeamOffer(db,[3]),/BOOKED_OFFER_REQUIRED/);
 await change();const offer=await approveTeamOffer(db,[3]),draft=await draftTeamSale(db,offer.options.find(o=>o.kind==="installments")!.id);
 expect(draft.source.booking).toMatchObject({postId:id(22),offerAttachmentRevision:1});expect(draft.quote.terms.payments.map(p=>p.amountCents)).toEqual([3333,3333,3335]);
 expect((await db.query("select product_id,video_action,allow_booking from posts where id=$1",[id(22)])).rows).toEqual([{product_id:null,video_action:"book",allow_booking:true}]);
});
test("only creator or appointed manager can attach within the owned booking and product",async()=>{
 await denied(()=>change(true,0,id(25),2),/TEAM_MANAGER_REQUIRED/);
 await addTeamMember(db,3,"manager",false);expect(await change(true,0,id(25),3)).toMatchObject({attached:true,revision:1});
 await db.query("insert into products(id,creator_id,title,type,currency) values($1,$2,'Foreign','course','usd')",[id(24),id(4)]);
 await denied(()=>change(true,0,id(26),1,teamSaleBooking,id(24)),/OWNED_ACTIVE_SALES_OFFER_REQUIRED/);
 await denied(()=>change(true,0,id(27),1,"10000000-0000-4000-8000-000000000030".replace("10000000","20000000")),/OWNED_SALES_CALL_REQUIRED/);
});
test("unknown response reuses original change and refuses a changed request or stale revision",async()=>{
 const original=await change();expect(await change()).toEqual(original);
 await denied(()=>change(false,0),/ORIGINAL_BOOKED_OFFER_REQUEST_CHANGED/);
 await denied(()=>change(false,0,id(26)),/BOOKED_OFFER_REVISION_CHANGED/);
 expect((await db.query("select count(*)::int n from sales_team_booked_offer_changes_v1")).rows).toEqual([{n:1}]);
});
test("detaching then reattaching invalidates an outstanding buyer review even at unchanged price",async()=>{
 await change();const offer=await approveTeamOffer(db,[3]),draft=await draftTeamSale(db,offer.options[0].id);
 await change(false,1,id(26));await change(true,2,id(27));
 await denied(()=>rpc(db,"accept_sales_team_sale_v1",[draft.saleId,id(10),draft.quote.fingerprint,true]),/SALE_TERMS_CHANGED|REVIEW_CURRENT_SALE_TERMS/);
});
test("accepted agreement and association audit survive without prospective mutation",async()=>{
 await change();const offer=await approveTeamOffer(db),draft=await draftTeamSale(db,offer.options[0].id);await rpc(db,"accept_sales_team_sale_v1",[draft.saleId,id(10),draft.quote.fingerprint,true]);
 await denied(()=>change(false,1,id(26)),/ACCEPTED_BOOKED_OFFER_FROZEN/);
 expect((await db.query("select terms from sales_team_sale_agreements_v1 where id=$1",[draft.saleId])).rows).toEqual([{terms:draft.quote.terms}]);
 await denied(()=>db.query("update sales_team_booked_offer_changes_v1 set attached=false"),/permission denied|IMMUTABLE/);
});
test("new activity hold preserves original request recovery and accepted source history",async()=>{
 const original=await change();await db.exec("update sales_team_controls_v1 set booked_offer_associations_enabled=false,new_sales_enabled=false");
 expect(await change()).toEqual(original);await denied(()=>change(false,1,id(26)),/TEAM_BOOKED_OFFERS_HELD/);
});
test("closer catalog is scoped to the assignment and never includes unassociated products",async()=>{
 await change();await approveTeamOffer(db,[3]);
 await db.query("insert into products(id,creator_id,title,type,currency,amount_cents,price_cents) values($1,$2,'Unattached course','course','usd',5000,5000)",[id(24),id(1)]);
 const catalog=await rpc<{offers:{id:string}[];options:{product_id:string}[]}>(db,"read_sales_team_offer_catalog_v2",[id(1),id(2),teamSaleBooking]);expect(catalog.offers.map(p=>p.id)).toEqual([id(21)]);expect(catalog.options.every(o=>o.product_id===id(21))).toBe(true);
 await denied(()=>rpc(db,"read_sales_team_offer_catalog_v2",[id(1),id(2),null]),/BOOKING_CLOSER_ACCESS_REQUIRED/);
 await denied(()=>rpc(db,"read_sales_team_offer_catalog_v2",[id(1),id(2),"10000000-0000-4000-8000-000000000002"]),/BOOKING_CLOSER_ACCESS_REQUIRED/);
 await denied(()=>rpc(db,"read_sales_team_booked_offer_choices_v1",[id(1),id(2),teamSaleBooking]),/TEAM_MANAGER_REQUIRED/);
});
test("an associated second offer still needs creator-approved price and payment options",async()=>{
 await change();await approveTeamOffer(db,[3]);await db.query("insert into products(id,creator_id,title,type,currency,amount_cents,price_cents) values($1,$2,'Second course','course','usd',5000,5000)",[id(24),id(1)]);
 await change(true,0,id(26),1,teamSaleBooking,id(24));
 const read=()=>rpc<{offers:{id:string}[];options:{product_id:string}[]}>(db,"read_sales_team_offer_catalog_v2",[id(1),id(2),teamSaleBooking]);
 const pending=await read();expect(pending.offers).toHaveLength(2);expect(pending.options.every(o=>o.product_id===id(21))).toBe(true);
 await rpc(db,"configure_sales_team_offer_v1",[id(1),id(1),id(24),id(27),5000,[]]);expect((await read()).options.filter(o=>o.product_id===id(24))).toHaveLength(1);
});
test("booked association history and management RPCs are service-only",async()=>{
 await change();await db.exec("set local role authenticated");await denied(()=>db.query("select * from sales_team_booked_offer_changes_v1"),/permission denied/);
 await denied(()=>change(false,1,id(26)),/permission denied/);
});
test("canonical Book association continues through verified first receipt and shared Library fulfillment",async()=>{
 const integrated=await teamSharedDatabase(createLocalPostgres());
 try{
  await installComposerGuard(integrated);await integrated.exec("alter table profiles add column role text");
  for(const file of ["20261021230016_sales_team_financial_statements.sql","20261023000533_sales_team_payment_events.sql","20261023002620_sales_team_financial_reconciliation.sql","20261023010604_sales_team_booked_offer_associations.sql"])await integrated.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
  const capture=await seedTeamCapture(integrated,{beforeSetup:async()=>{
   await integrated.query("insert into posts(id,creator_id,allow_booking,video_action,action_version,booking_url) values($1,$2,true,'book',1,'https://calendar.example/original')",[id(22),id(1)]);
   await integrated.query("update bookings set post_id=$1 where id=$2",[id(22),teamSaleBooking]);
  },beforeApproval:async()=>{
   await integrated.exec("update sales_team_controls_v1 set booked_offer_associations_enabled=true,fulfillment_enabled=true,event_reconciliation_enabled=true,financial_reconciliation_enabled=true");
   await rpc(integrated,"manage_sales_team_booked_offer_v1",[id(1),id(1),teamSaleBooking,id(21),id(25),0,true]);
  }});
  const receipt=await capture.record(),purchase=await capture.rpc<{purchaseId:string}>("fulfill_sales_team_receipt_v1",[capture.sale,capture.buyer,receipt.id]);
  await integrated.query("update profiles set role='admin' where id=$1",[id(29)]);let sequence=0;
  const raw=jest.fn(async(method:string,path:string)=>{
   if(method!=="GET")throw Error("Integrated financial inspection cannot write to provider");
   const value=path==="/v1/payment_intents/pi_original"?capture.base.paymentIntent:path==="/v1/charges/ch_original"?capture.base.charge:path==="/v1/balance_transactions/txn_original"?capture.base.balance:path==="/v1/refunds"||path==="/v1/disputes"?{object:"list",data:[],has_more:false}:null;
   if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_integrated${++sequence}`}}));
  });
  expect(await inspectTeamReceiptFinancials({admin:teamSupabaseFixture(integrated),stripe:{rawRequest:raw},context:capture.contract.context,observeContext:async()=>capture.contract.context,observeEvidence:async()=>capture.evidence},String(receipt.id),id(29))).toMatchObject({held:false});
  expect(await capture.rpc("read_sales_team_entitlement_v1",[purchase.purchaseId,capture.buyer])).toMatchObject({allowed:true});
  expect((await integrated.query("select post_id,product_id,access_granted from purchases")).rows).toEqual([{post_id:id(22),product_id:id(21),access_granted:false}]);
  expect((await integrated.query("select video_action,product_id,allow_booking from posts where id=$1",[id(22)])).rows).toEqual([{video_action:"book",product_id:null,allow_booking:true}]);
  expect((await integrated.query("select count(*)::int n from product_delivery_revisions")).rows).toEqual([{n:1}]);
 }finally{await integrated.close();}
},30000);
