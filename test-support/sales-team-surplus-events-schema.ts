import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
export const signedSurplusCandidate="supabase/migrations/20261028224405_sales_team_signed_surplus_events.sql";
/** Disposable structural base plus the actual shared lease/token functions.
 * This does not prove actual installed/historical shared-schema compatibility. */
export async function installSignedSurplusEventsFixture(db:PGlite,install=true){
 await db.exec("create table public.stripe_events(id text primary key,type text not null,created_at timestamptz not null default now())");
 const sql=readFileSync("supabase/schema/019-creator-processing-fees.sql","utf8"),start=sql.indexOf("alter table public.stripe_events"),end=sql.indexOf("-- Stripe does not guarantee webhook delivery order.");
 if(start<0||end<start)throw Error("Exact shared event fixture source required");await db.exec(sql.slice(start,end));
 await db.exec("revoke all on function public.claim_stripe_event(text,text,integer,uuid),public.complete_stripe_event(text,uuid),public.release_stripe_event(text,uuid) from public,anon,authenticated;grant execute on function public.claim_stripe_event(text,text,integer,uuid),public.complete_stripe_event(text,uuid),public.release_stripe_event(text,uuid) to service_role");
 if(install)await db.exec(readFileSync(signedSurplusCandidate,"utf8"));
}
