/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { addTeamMember,salesTeamDatabase,teamFixtureId as id,teamRpc } from "@/test-support/sales-team-postgres";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
type Result={booking_id:string;lead_reused:boolean;scheduling_status:string;assignment:{membership_id:string};reused:boolean};
const seed=async(kind="lead",source:string|null=null,buyer=10,creator=1,post=20)=>(await db.query<{result:Result}>(
 "select public.seed_sales_team_booking_v1($1,$2,$3,$4,$5) result",[id(creator),id(buyer),id(post),kind,source])).rows[0].result;
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{
 await db.exec("savepoint denial");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denial");}
};
beforeAll(async()=>{
 db=await salesTeamDatabase(createLocalPostgres());
 await db.exec(`create table public.booking_payments(id uuid primary key,booking_id uuid);
  create table public.discover_booking_attribution_v1(id uuid primary key,user_id uuid,creator_id uuid,post_id uuid);
  create table public.free_booking_checkouts(id uuid primary key,buyer_id uuid,creator_id uuid,post_id uuid,status text);
  grant select on public.booking_payments,public.discover_booking_attribution_v1,public.free_booking_checkouts to service_role;
  grant insert on public.bookings to service_role;`);
 await db.exec(readFileSync("supabase/migrations/20261021222610_sales_team_booking_source_routing.sql","utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin; update public.sales_team_controls_v1 set access_enabled=true,new_sales_enabled=true");
 await addTeamMember(db,2);await addTeamMember(db,3);
 await teamRpc(db,1,"configure_routing",{enabled:true});
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});

test("repeated lead requests preserve one durable booking and one routing turn",async()=>{
 const first=await seed();const repeated=await Promise.all([seed(),seed(),seed()]);
 expect(repeated.every(r=>r.booking_id===first.booking_id&&r.reused&&r.lead_reused)).toBe(true);
 expect(first.scheduling_status).toBe("awaiting_confirmation");
 expect((await db.query<{count:number}>("select sum(route_count)::integer count from public.sales_team_destination_bindings_v1")).rows[0].count).toBe(1);
});
test("verified checkout and calendar attribution alias the same unpaid lead",async()=>{
 const first=await seed();
 await db.query("insert into public.discover_booking_attribution_v1 values($1,$2,$3,$4)",[id(25),id(10),id(1),id(20)]);
 await db.query("insert into public.free_booking_checkouts values($1,$2,$3,$4,'complete')",[id(26),id(10),id(1),id(20)]);
 expect((await seed("attribution",id(25))).booking_id).toBe(first.booking_id);
 expect((await seed("free_checkout",id(26))).booking_id).toBe(first.booking_id);
 expect((await db.query("select * from public.sales_team_booking_sources_v1")).rows).toHaveLength(3);
 expect((await db.query("select * from public.sales_team_assignments_v1")).rows).toHaveLength(1);
});
test("attribution cannot be borrowed from another buyer, creator or post",async()=>{
 await db.query("insert into public.discover_booking_attribution_v1 values($1,$2,$3,$4)",[id(25),id(11),id(1),id(20)]);
 await denied(()=>seed("attribution",id(25)),/BOOKING_SOURCE_MISMATCH/);
 await denied(()=>seed("free_checkout",id(25)),/BOOKING_SOURCE_MISMATCH/);
 await denied(()=>seed("lead",id(25)),/BOOKING_SOURCE_MISMATCH/);
 await denied(()=>seed("lead",null,10,12),/TEAM_ROUTING_NOT_ENABLED/);
 await denied(()=>seed("lead",null,1),/BOOKING_BUYER_REQUIRED/);
});
test("historical and financially touched rows are never adopted",async()=>{
 const old=(await db.query<{id:string}>("select id from public.bookings limit 1")).rows[0].id;
 await db.query("update public.bookings set created_at=clock_timestamp() where id=$1",[old]);
 await db.query("insert into public.booking_payments values($1,$2)",[id(25),old]);
 const fresh=await seed();expect(fresh.booking_id).not.toBe(old);
 expect((await db.query("select * from public.sales_team_assignments_v1 where booking_id=$1",[old])).rows).toHaveLength(0);
});
test("unavailable members and closed controls do not create a lead or consume a turn",async()=>{
 await db.exec("update public.sales_team_recipients_v1 set payouts_ready=false");
 await denied(()=>seed(),/NO_ELIGIBLE_TEAM_DESTINATION/);
 expect((await db.query("select * from public.sales_team_booking_sources_v1")).rows).toHaveLength(0);
 await db.exec("update public.sales_team_controls_v1 set new_sales_enabled=false");
 await denied(()=>seed(),/TEAM_SALES_DISABLED/);
});
test("service callers cannot route a forged post and browser roles cannot invoke the transaction",async()=>{
 await db.query("update public.posts set creator_id=$1 where id=$2",[id(12),id(20)]);
 await denied(()=>seed(),/BOOKING_OFFER_MISMATCH/);
 await db.exec("set local role authenticated");
 await denied(()=>seed(),/permission denied/);
 await db.exec("reset role");
});
