import type {PGlite} from "@electric-sql/pglite";
import {teamFixtureId as id} from "./sales-team-postgres";
import {captureRpc as rpc} from "./sales-team-capture-postgres";

export const ordinary={product:id(9701),post:id(9702),revision:id(9703),order:id(9704),purchase:id(9705),ledger:id(9706),asset:id(9707)};
export const monthly={product:id(9711),post:id(9712),revision:id(9713),agreement:id(9714),purchase:id(9715),ledger:id(9716)};
export const historyTables=["profiles","posts","products","orders","purchases","payment_fee_ledger","monthly_mentorship_agreements_v1",
 "private_video_assets","product_delivery_revisions","product_delivery_videos","checkout_delivery_snapshots","purchase_deliveries","discover_events_v1"] as const;
export const deliveryTables=["private_video_assets","product_delivery_revisions","product_delivery_videos","checkout_delivery_snapshots","purchase_deliveries"] as const;
export type Snapshot=Record<string,unknown[]>;

export async function preinstallationSnapshot(db:PGlite,tables:readonly string[]=historyTables):Promise<Snapshot>{
 const result:Snapshot={};
 for(const table of tables)result[table]=(await db.query<{v:unknown[]}>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) v from public.${table} t`)).rows[0].v;
 return result;
}
export async function seedPreinstallationHistory(db:PGlite){
 // Historical rows are synthetic. Real retained owners credit the one-time
 // purchase; the monthly invoice is seeded as already credited by its owner.
 await db.query(`insert into products(id,product_id,creator_id,post_id,title,type,amount_cents,price_cents,currency,membership_terms,deliver_url)
  values($1,$1,$2,$3,'Original course','course',1000,1000,'usd',null,'https://fixture.invalid/preinstall/course'),
        ($4,$4,$2,$5,'Original monthly service','mentorship',1000,1000,'usd','{"version":"monthly-mentorship-v1","minimumMonths":1,"autoRenew":true}','https://fixture.invalid/preinstall/monthly')`,
 [ordinary.product,id(1),ordinary.post,monthly.product,monthly.post]);
 await db.query("insert into posts(id,creator_id,product_id,title) values($1,$2,$3,'Original course'),($4,$2,$5,'Original monthly service')",[ordinary.post,id(1),ordinary.product,monthly.post,monthly.product]);
 await db.query(`insert into product_delivery_revisions(id,product_id,creator_id,links,created_at)
  values($1,$2,$3,'[{"label":"Original course","url":"https://fixture.invalid/preinstall/course"}]','2026-09-01T12:00:00Z'),
        ($4,$5,$3,'[{"label":"Original service","url":"https://fixture.invalid/preinstall/monthly"}]','2026-09-01T12:00:00Z')`,[ordinary.revision,ordinary.product,id(1),monthly.revision,monthly.product]);
 await db.query("update products set delivery_revision=case id when $1 then $2::uuid else $3::uuid end where id in ($1,$4)",[ordinary.product,ordinary.revision,monthly.revision,monthly.product]);
 await db.query("insert into private_video_assets(id,creator_id,provider,provider_id,status,name) values($1,$2,'supabase','preinstall/original.mp4','ready','Original paid video')",[ordinary.asset,id(1)]);
 await db.query("insert into product_delivery_videos(revision_id,asset_id,creator_id,label,position) values($1,$2,$3,'Original video',0)",[ordinary.revision,ordinary.asset,id(1)]);
 await db.query(`insert into orders(id,buyer_id,post_id,creator_id,amount_cents,gross_amount,platform_fee,processing_fee,total_creator_deduction,creator_amount,currency,status,stripe_payment_intent_id)
  values($1,$2,$3,$4,1000,1000,120,30,150,850,'usd','paid','pi_preinstall_ordinary')`,[ordinary.order,id(10),ordinary.post,id(1)]);
 await rpc(db,"prepare_checkout_delivery_v1",[ordinary.order,id(10),ordinary.product,ordinary.revision,1000]);
 await db.query(`insert into purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,order_id,amount_cents,currency,status,product_type,access_granted,payment_intent_id,paid_at,platform_fee_cents,processing_fee_cents)
  values($1,$2,$2,$3,$4,$5,$6,1000,'usd','paid','course',true,'pi_preinstall_ordinary','2026-09-02T12:00:00Z',120,30)`,[ordinary.purchase,id(10),id(1),ordinary.product,ordinary.post,ordinary.order]);
 if(await rpc<boolean>(db,"credit_purchase_earnings",[ordinary.purchase,850])!==true)throw Error("Historical one-time credit was not recorded");
 await db.query(`insert into monthly_mentorship_agreements_v1(id,purchase_id,buyer_id,creator_id,product_id,post_id,stripe_subscription_id,covered_months)
  values($1,$2,$3,$4,$5,$6,'sub_preinstall_monthly',2)`,[monthly.agreement,monthly.purchase,id(11),id(1),monthly.product,monthly.post]);
 await db.query(`insert into purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,amount_cents,currency,status,kind,product_type,access_granted,monthly_mentorship_id,subscription_id,paid_at)
  values($1,$2,$2,$3,$4,$5,1000,'usd','active','monthly_mentorship_v1','mentorship',false,$6,'sub_preinstall_monthly','2026-09-02T12:00:00Z')`,[monthly.purchase,id(11),id(1),monthly.product,monthly.post,monthly.agreement]);
 await db.query(`insert into payment_fee_ledger(id,creator_id,purchase_id,order_id,stripe_payment_intent_id,stripe_charge_id,stripe_invoice_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version,status,earnings_credited_at)
  values($1,$2,$3,$4,'pi_preinstall_ordinary','ch_preinstall_ordinary',null,1000,120,30,150,850,'usd','legacy','paid',null),
        ($5,$2,$6,null,'pi_preinstall_monthly','ch_preinstall_monthly','in_preinstall_monthly',1000,120,30,150,850,'usd','legacy','paid','2026-09-02T12:00:00Z')`,[ordinary.ledger,id(1),ordinary.purchase,ordinary.order,monthly.ledger,monthly.purchase]);
 await db.query("update profiles set total_earnings_cents=total_earnings_cents+850 where id=$1",[id(1)]);
 await db.query("update profiles set total_earnings_cents=777 where id=$1",[id(4)]);
}
