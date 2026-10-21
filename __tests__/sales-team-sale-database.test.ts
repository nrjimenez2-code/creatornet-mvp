/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale,teamSaleBooking } from "@/test-support/sales-team-sale-postgres";
import { teamFixtureId as id,teamRpc } from "@/test-support/sales-team-postgres";
import { commissionAppliesToPeriod, publicTeamSaleTerms } from "@/lib/salesTeams/agreement";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{
 await db.exec("savepoint expected_denial");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint expected_denial");}
};
const accept=(saleId:string,fingerprint:string,buyer=10,accepted=true)=>db.query("select public.accept_sales_team_sale_v1($1,$2,$3,$4)",[saleId,id(buyer),fingerprint,accepted]);
beforeAll(async()=>{db=await salesTeamSaleDatabase(createLocalPostgres());},30000);
beforeEach(async()=>{await db.exec("begin");await enableTeamSalesFixture(db);});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});

test("full-only approval creates no unauthorized installment option",async()=>{
 const offer=await approveTeamOffer(db);expect(offer.options).toHaveLength(1);expect(offer.options[0]).toMatchObject({kind:"full",payment_count:1});
 await denied(()=>draftTeamSale(db,id(24)),/APPROVED_OFFER_CHANGED/);
 const draft=await draftTeamSale(db,offer.options[0].id);expect(draft.quote.terms.payments).toEqual([{number:1,amountCents:10001}]);
});
test("any fixed booked offer can have approved exact-cent installments without altering legacy purchases",async()=>{
 const offer=await approveTeamOffer(db,[2,3]);const option=offer.options.find(o=>o.payment_count===3)!;
 const draft=await draftTeamSale(db,option.id);expect(draft.quote.terms.payments.map(p=>p.amountCents)).toEqual([3333,3333,3335]);
 expect((await db.query<{amount_cents:number;installment_options:number[]}>("select amount_cents,installment_options from products")).rows[0]).toEqual({amount_cents:10001,installment_options:[]});
});
test.each(["video","course","mentorship","bundle","call"])("a booked %s uses only its approved offer and exact payment choices",async type=>{
 await db.query("update products set type=$1",[type]);const offer=await approveTeamOffer(db,[3]);const draft=await draftTeamSale(db,offer.options.find(o=>o.kind==="installments")!.id);
 expect(draft.quote.terms.payments.reduce((sum,p)=>sum+p.amountCents,0)).toBe(10001);await accept(draft.saleId,draft.quote.fingerprint);
});
test("only the exact buyer accepts; closers and callers cannot accept on the buyer's behalf",async()=>{
 const offer=await approveTeamOffer(db);const draft=await draftTeamSale(db,offer.options[0].id);
 await denied(()=>accept(draft.saleId,draft.quote.fingerprint,2),/BUYER_ACCEPTANCE_REQUIRED/);
 await denied(()=>accept(draft.saleId,draft.quote.fingerprint,10,false),/BUYER_ACCEPTANCE_REQUIRED/);
 await denied(()=>accept(draft.saleId,"a".repeat(64)),/REVIEW_CURRENT_SALE_TERMS/);
 await accept(draft.saleId,draft.quote.fingerprint);await accept(draft.saleId,draft.quote.fingerprint);
 expect((await db.query("select * from public.sales_team_sale_agreements_v1")).rows).toHaveLength(1);
});
test("prospective product, approval, membership or recipient changes require a fresh buyer review",async()=>{
 const offer=await approveTeamOffer(db);const draft=await draftTeamSale(db,offer.options[0].id);
 await db.query("update public.products set title='Changed listing'");
 await denied(()=>accept(draft.saleId,draft.quote.fingerprint),/APPROVED_OFFER_CHANGED/);
});
test("commission changes invalidate pending review but preserve an accepted immutable agreement",async()=>{
 const offer=await approveTeamOffer(db);const draft=await draftTeamSale(db,offer.options[0].id);await accept(draft.saleId,draft.quote.fingerprint);
 const saved=(await db.query("select terms from public.sales_team_sale_agreements_v1")).rows;
 const member=(await db.query<{id:string}>("select id from public.sales_team_memberships_v1")).rows[0].id;
 await teamRpc(db,1,"configure_member",{membership_id:member,role:"closer",is_closer:true,commission_bps:2000,hold_days:30,renewal_rule:"every_renewal",expected_revision:1});
 await teamRpc(db,1,"remove_member",{membership_id:member});
 await accept(draft.saleId,draft.quote.fingerprint);expect((await db.query("select terms from public.sales_team_sale_agreements_v1")).rows).toEqual(saved);
 await denied(()=>db.query("update public.sales_team_sale_agreements_v1 set terms='{}'"),/TEAM_HISTORY_IS_IMMUTABLE/);
});
test("review-only option replacement is safe; accepted payment paths require recovery",async()=>{
 const offer=await approveTeamOffer(db,[3]),full=offer.options.find(o=>o.kind==="full")!,plan=offer.options.find(o=>o.kind==="installments")!;
 const a=await draftTeamSale(db,full.id,id(28));const b=await draftTeamSale(db,plan.id,id(29));
 expect((await db.query<{status:string}>("select status from public.sales_team_sale_requests_v1 where id=$1",[a.saleId])).rows[0].status).toBe("superseded");
 await denied(()=>accept(a.saleId,a.quote.fingerprint),/REVIEW_CURRENT_SALE_TERMS/);await accept(b.saleId,b.quote.fingerprint);
 await denied(()=>draftTeamSale(db,full.id,id(27)),/EXISTING_PAYMENT_REQUIRES_RECOVERY/);
});
test("unresolved legacy payment links and unverified pricing/reserves prevent a new commissioned path",async()=>{
 const offer=await approveTeamOffer(db);
 await db.query("insert into public.booking_payments(id,booking_id,status) values($1,$2,'link_sent')",[id(25),teamSaleBooking]);
 await denied(()=>draftTeamSale(db,offer.options[0].id),/EXISTING_PAYMENT_REQUIRES_RECOVERY/);
 await db.query("delete from public.booking_payments");await db.exec("update public.sales_team_financial_config_v1 set reserves_verified=false");
 await denied(()=>draftTeamSale(db,offer.options[0].id),/TEAM_FINANCIAL_CONFIG_REQUIRED/);
});
test("buyer projection excludes recipient banking identities and internal commission terms",async()=>{
 const offer=await approveTeamOffer(db),draft=await draftTeamSale(db,offer.options[0].id);const publicTerms=publicTeamSaleTerms(draft.quote.terms);
 expect(publicTerms).not.toHaveProperty("distribution");expect(publicTerms).not.toHaveProperty("commission");expect(JSON.stringify(publicTerms)).not.toContain("acct_");
 expect(commissionAppliesToPeriod({...draft.quote.terms,paymentKind:"monthly",initialCommitmentMonths:1},1)).toBe(true);
 expect(commissionAppliesToPeriod({...draft.quote.terms,paymentKind:"monthly",initialCommitmentMonths:1},2)).toBe(false);
 expect(commissionAppliesToPeriod({...draft.quote.terms,paymentKind:"monthly",commission:{...draft.quote.terms.commission,renewals:"every_renewal"}},12)).toBe(true);
});
