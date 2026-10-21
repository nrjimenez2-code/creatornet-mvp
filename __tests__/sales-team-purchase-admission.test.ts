/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "@/test-support/sales-team-sale-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {quoteTeamSale,type TeamSaleSource} from "@/lib/salesTeams/agreement";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;let draft:Awaited<ReturnType<typeof draftTeamSale>>,optionId:string;
const accept=()=>db.query("select public.accept_sales_team_sale_v1($1,$2,$3,true)",[draft.saleId,id(10),draft.quote.fingerprint]);
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
beforeAll(async()=>{db=await salesTeamSaleDatabase(createLocalPostgres(),{sharedAdmission:true});},30000);
beforeEach(async()=>{await db.exec("begin");await enableTeamSalesFixture(db);const offer=await approveTeamOffer(db);optionId=offer.options[0].id;draft=await draftTeamSale(db,optionId);});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
test("a legacy attempt admitted first blocks team acceptance without reserving a second path",async()=>{
 await db.query("insert into product_checkout_attempts(id,buyer_id,product_id,attempt_key,status) values($1,$2,$3,$4,'creating')",[id(40),id(10),id(21),id(41)]);
 await denied(accept,/EXISTING_PAYMENT_REQUIRES_RECOVERY/);expect((await db.query("select * from sales_team_purchase_admissions_v1")).rows).toHaveLength(0);
});
test("accepted team sales fence legacy payment admission before any provider dispatch",async()=>{
 await accept();
 await denied(()=>db.query("insert into product_checkout_attempts(id,buyer_id,product_id,attempt_key,status) values($1,$2,$3,$4,'creating')",[id(40),id(10),id(21),id(41)]),/TEAM_SALE_OWNS_PURCHASE_ADMISSION/);
 await denied(()=>db.query("insert into full_manual_checkout_requests_v1(id,buyer_id,product_id) values($1,$2,$3)",[id(40),id(10),id(21)]),/TEAM_SALE_OWNS_PURCHASE_ADMISSION/);
 await denied(()=>db.query("insert into monthly_mentorship_agreements_v1(id,buyer_id,product_id) values($1,$2,$3)",[id(40),id(10),id(21)]),/TEAM_SALE_OWNS_PURCHASE_ADMISSION/);
});
test("an exact-installment JSON identity cannot bypass the shared buyer/product slot",async()=>{
 await accept();
 await denied(()=>db.query("insert into exact_installment_agreements(id,terms) values($1,$2)",[id(40),JSON.stringify({buyerId:id(10),productId:id(21)})]),/TEAM_SALE_OWNS_PURCHASE_ADMISSION/);
});
test("product aliases resolve to the same shared admission identity",async()=>{
 await db.query("update products set product_id=$1",[id(42)]);await accept();
 await denied(()=>db.query("insert into product_checkout_attempts(id,buyer_id,product_id,attempt_key,status) values($1,$2,$3,$4,'creating')",[id(40),id(10),id(42),id(41)]),/TEAM_SALE_OWNS_PURCHASE_ADMISSION/);
});
test("another buyer's legacy purchase and original recovery stay independent",async()=>{
 await accept();await db.query("insert into product_checkout_attempts(id,buyer_id,product_id,attempt_key,status) values($1,$2,$3,$4,'creating')",[id(40),id(11),id(21),id(41)]);
 await db.exec("update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false;update product_checkout_attempts set status='complete'");
 expect((await db.query<{status:string}>("select status from product_checkout_attempts")).rows[0].status).toBe("complete");
});
test("two bookings for the same buyer/offer cannot produce parallel accepted sales",async()=>{
 await accept();const booking2="10000000-0000-4000-8000-000000000002";
 await db.query("select public.assign_sales_team_booking_v1($1,$2,null)",[booking2,id(10)]);
 const source=(await db.query<{result:TeamSaleSource}>("select public.read_sales_team_sale_source_v1($1,$2,$3) result",[booking2,id(2),optionId])).rows[0].result;
 const quote=quoteTeamSale(source,id(28));
 await db.query("select public.prepare_sales_team_sale_v1($1,$2,$3,$4,$5,$6,$7)",[id(28),booking2,id(2),optionId,JSON.stringify(source),JSON.stringify(quote.terms),quote.fingerprint]);
 await denied(()=>db.query("select public.accept_sales_team_sale_v1($1,$2,$3,true)",[id(28),id(10),quote.fingerprint]),/EXISTING_TEAM_SALE_REQUIRES_RECOVERY/);
});
test("an existing purchase is preserved and cannot be adopted into a commissioned sale",async()=>{
 await db.query("insert into purchases(id,buyer_id,product_id) values($1,$2,$3)",[id(40),id(10),id(21)]);await denied(accept,/EXISTING_PAYMENT_REQUIRES_RECOVERY/);
 expect((await db.query("select * from purchases")).rows).toHaveLength(1);
});
test("shared admission works through the real service role, with no direct client execution",async()=>{
 await db.exec("set local role service_role");await accept();expect((await db.query("select * from sales_team_purchase_admissions_v1")).rows).toHaveLength(1);
 await db.exec("set local role authenticated");await denied(()=>db.query("select * from sales_team_purchase_admissions_v1"),/permission denied/);
});
