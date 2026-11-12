import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { salesTeamDatabase,addTeamMember,teamFixtureId as id } from "./sales-team-postgres";
import { quoteTeamSale,type TeamSaleSource } from "@/lib/salesTeams/agreement";

export const teamSaleBooking="10000000-0000-4000-8000-000000000001";
export async function salesTeamSaleDatabase(db:PGlite,options:{sharedAdmission?:boolean}={}){
 await salesTeamDatabase(db);
 await db.exec(`create table public.products(id uuid primary key,product_id uuid,creator_id uuid,title text,description text,type text,
 amount_cents integer,price_cents integer,currency text,membership_terms jsonb,fixed_service_months integer,delivery_revision uuid,active boolean default true,is_active boolean default true);
 create table public.booking_payments(id uuid primary key,booking_id uuid,status text,buyer_id uuid,product_id uuid);
 grant select on public.products,public.booking_payments to service_role;
 insert into public.products(id,product_id,creator_id,title,type,amount_cents,price_cents,currency)
 values('${id(21)}','${id(21)}','${id(1)}','Booked course','course',10001,10001,'usd');
 update public.posts set product_id='${id(21)}';`);
 await db.exec(readFileSync("supabase/migrations/20260921011747_mentorship_installment_options.sql","utf8"));
 await db.exec(readFileSync("supabase/migrations/20261021214956_sales_team_approved_sale_agreements.sql","utf8"));
 if(options.sharedAdmission){
  await db.exec(`create table public.product_checkout_attempts(id uuid primary key,buyer_id uuid,product_id uuid,attempt_key uuid,status text);
   create table public.buyer_mentorship_installment_reservations_v1(id uuid primary key,buyer_id uuid,product_id uuid);
   create table public.monthly_mentorship_agreements_v1(id uuid primary key,buyer_id uuid,product_id uuid);
   create table public.full_manual_checkout_requests_v1(id uuid primary key,buyer_id uuid,product_id uuid);
   create table public.exact_installment_agreements(id uuid primary key,terms jsonb);
   create table public.exact_installment_context_reservations_v2(id uuid primary key,terms jsonb);
   create table public.purchases(id uuid primary key,buyer_id uuid,product_id uuid);
   create table public.orders(id uuid primary key,buyer_id uuid,post_id uuid);
   grant select on public.product_checkout_attempts,public.buyer_mentorship_installment_reservations_v1,public.monthly_mentorship_agreements_v1,
    public.full_manual_checkout_requests_v1,public.exact_installment_agreements,public.exact_installment_context_reservations_v2,public.purchases,public.orders to service_role;`);
  await db.exec(readFileSync("supabase/migrations/20261021221847_sales_team_shared_purchase_admission.sql","utf8"));
 }
 return db;
}
export async function enableTeamSalesFixture(db:PGlite,options:{assignBooking?:boolean}={}){
 await db.exec(`update public.sales_team_controls_v1 set access_enabled=true,new_sales_enabled=true;
 update public.sales_team_financial_config_v1 set context='{"version":"exact-payment-context-v1","mode":"test","platformAccountId":"acct_platform","supabaseProjectRef":"abcdefghijklmnopqrst","siteOrigin":"https://fixture.vercel.app"}',
 processing_fees='{"enabled":true,"basisPoints":290,"fixedCents":30,"version":"fixture-v1"}',fee_disclosure_version='fixture-fees-v1',commission_disclosure_version='fixture-commissions-v1',
 actual_pricing_verified=true,reserves_verified=true,disclosures_approved=true;
 insert into public.sales_team_recipients_v1(user_id,account_id,platform_account_id,mode,country,currency,transfers_active,payouts_ready,ownership_verified,verified_at,evidence)
 values('${id(1)}','acct_creator','acct_platform','test','US','usd',true,true,true,now(),'{}');`);
 const member=await addTeamMember(db,2);
 if(options.assignBooking!==false)await db.query("select public.assign_sales_team_booking_v1($1,$2,null)",[teamSaleBooking,id(10)]);
 return member;
}
export async function approveTeamOffer(db:PGlite,counts:number[]=[],request=id(30),actor=1){
 return (await db.query<{result:{approval:Record<string,unknown>;options:{id:string;kind:string;payment_count:number}[]}}>(
  "select public.configure_sales_team_offer_v1($1,$2,$3,$4,$5,$6::smallint[]) result",[id(1),id(actor),id(21),request,10001,counts])).rows[0].result;
}
export async function draftTeamSale(db:PGlite,optionId:string,saleId=id(29)){
 const source=(await db.query<{result:TeamSaleSource}>("select public.read_sales_team_sale_source_v1($1,$2,$3) result",[teamSaleBooking,id(2),optionId])).rows[0].result;
 const quote=quoteTeamSale(source,saleId);
 const result=(await db.query<{result:Record<string,unknown>}>("select public.prepare_sales_team_sale_v1($1,$2,$3,$4,$5,$6,$7) result",
  [saleId,teamSaleBooking,id(2),optionId,JSON.stringify(source),JSON.stringify(quote.terms),quote.fingerprint])).rows[0].result;
 return {source,quote,result,saleId};
}
