import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
export const teamCashCandidate="supabase/migrations/20261023024119_sales_team_cash_reservations.sql";
/** Explicit synthetic coverage for core cash-contract tests. This is not the
 * production legacy/shared-liability adapter or its acceptance evidence. */
export async function installTeamCashFixture(db:PGlite){
 await db.exec(readFileSync(teamCashCandidate,"utf8"));
 await db.exec(`create table public.fixture_shared_cash(singleton boolean primary key default true,protected_cents bigint not null default 0,revision text not null default 'fixture-v1');
  insert into fixture_shared_cash(singleton) values(true);
  grant select on fixture_shared_cash to service_role;
  create or replace function creatornet_team_private.shared_platform_cash_liabilities_v1(p_context jsonb) returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
   select jsonb_build_object('protectedCents',protected_cents,'sourceRevision',revision) from public.fixture_shared_cash where singleton
  $$;
  update public.sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,
   shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),evidence='{"scope":"synthetic local fixture only"}';`);
}
export const teamCashBalanceFixture={object:"balance",livemode:false,available:[{currency:"usd",amount:1000000,source_types:{card:1000000}}],pending:[]};
