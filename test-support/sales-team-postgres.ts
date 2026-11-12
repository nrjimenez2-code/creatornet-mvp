import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

export const teamFixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
export async function salesTeamDatabase(db: PGlite) {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; grant usage on schema auth to authenticated,service_role;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table public.posts(id uuid primary key,creator_id uuid,product_id uuid,allow_booking boolean default true);
    create table public.bookings(id uuid primary key,creator_id uuid,buyer_id uuid,post_id uuid,status text default 'booked',linked_order_id uuid,created_at timestamptz default now());
    create table public.booking_targets(id uuid primary key,creator_id uuid,name text,booking_url text,weight integer default 1,
      is_active boolean default true,active boolean default true,created_at timestamptz default now());
    grant select on public.posts to service_role;
    grant select,update on public.bookings,public.booking_targets to service_role;
    insert into auth.users(id,email,email_confirmed_at) select
      ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'user'||n||'@example.test',now() from generate_series(1,30)n;
    insert into public.posts(id,creator_id) values('${teamFixtureId(20)}','${teamFixtureId(1)}');
    insert into public.bookings(id,creator_id,buyer_id,post_id) select
      ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${teamFixtureId(1)}','${teamFixtureId(10)}','${teamFixtureId(20)}' from generate_series(1,30)n;`);
  await db.exec(readFileSync("supabase/migrations/20261021214158_sales_team_access_and_assignments.sql","utf8"));
  return db;
}
export async function teamRpc(db: PGlite, actor: number, action: string, input: Record<string,unknown>, creator=1) {
  return (await db.query<{result: Record<string,unknown>}>("select public.manage_sales_team_v1($1,$2,$3,$4) result",
    [teamFixtureId(creator),teamFixtureId(actor),action,JSON.stringify(input)])).rows[0].result;
}
export async function addTeamMember(db: PGlite, user: number, role="closer", isCloser=true) {
  const token = String(user).padStart(64,"0");
  await teamRpc(db,1,"invite",{email:`user${user}@example.test`,role,is_closer:isCloser,commission_bps:1000,hold_days:14,renewal_rule:"initial_commitment",token_hash:token});
  const accepted = await teamRpc(db,user,"accept_invitation",{token_hash:token});
  const id=String(accepted.id);
  await teamRpc(db,user,"accept_terms",{accepted:true,revision:1,version:"creatornet-team-commission-v1"});
  await db.query(`insert into public.sales_team_recipients_v1(user_id,account_id,platform_account_id,mode,country,currency,transfers_active,payouts_ready,ownership_verified,verified_at,evidence)
    values($1,$2,'acct_platform','test','US','usd',true,true,true,now(),'{}')`,[teamFixtureId(user),`acct_member${user}`]);
  if (!isCloser) return id;
  const target=teamFixtureId(user+100);
  await db.query("insert into public.booking_targets(id,creator_id,name,booking_url,weight) values($1,$2,$3,$4,$5)",[target,teamFixtureId(1),`Closer ${user}`,`https://calendar.example/closer${user}`,user===3?3:1]);
  await teamRpc(db,1,"bind_destination",{target_id:target,membership_id:id});
  return id;
}
