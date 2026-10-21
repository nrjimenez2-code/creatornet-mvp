/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { addTeamMember, salesTeamDatabase, teamFixtureId as id, teamRpc } from "@/test-support/sales-team-postgres";

let db:PGlite;
declare const createLocalPostgres:()=>PGlite;
const booking=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const assign=async(n:number,actor=10,member:string|null=null)=>(await db.query<{result:{assignment:{membership_id:string;revision:number};reused:boolean}}>(
 "select public.assign_sales_team_booking_v1($1,$2,$3) result",[booking(n),id(actor),member])).rows[0].result;
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{
 await db.exec("savepoint expected_denial");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint expected_denial");}
};
beforeAll(async()=>{db=await salesTeamDatabase(createLocalPostgres());},30000);
beforeEach(async()=>{await db.exec("begin; update public.sales_team_controls_v1 set access_enabled=true,new_sales_enabled=true");});
afterEach(async()=>{await db.exec("rollback");});
afterAll(async()=>{await db.close();});

test("freshly installed team controls are all closed",async()=>{
 await db.exec("rollback");
 const row=(await db.query<{access_enabled:boolean;new_sales_enabled:boolean;settlement_enabled:boolean}>("select * from public.sales_team_controls_v1")).rows[0];
 expect(row).toMatchObject({access_enabled:false,new_sales_enabled:false,settlement_enabled:false});
 await db.exec("begin");await denied(()=>teamRpc(db,1,"invite",{}),/TEAM_ACCESS_DISABLED/);
});
test("individual verified invitation identity and explicit term acceptance are mandatory",async()=>{
 await teamRpc(db,1,"invite",{email:"user2@example.test",role:"closer",is_closer:true,commission_bps:1000,hold_days:14,renewal_rule:"initial_commitment",token_hash:"a".repeat(64)});
 await denied(()=>teamRpc(db,3,"accept_invitation",{token_hash:"a".repeat(64)}),/INVITATION_UNAVAILABLE/);
 const accepted=await teamRpc(db,2,"accept_invitation",{token_hash:"a".repeat(64)});
 expect(accepted.id).toBeTruthy();
 expect((await db.query<{ready:boolean}>("select public.sales_team_member_ready_v1($1) ready",[accepted.id])).rows[0].ready).toBe(false);
 await denied(()=>teamRpc(db,2,"accept_terms",{}),/REVIEW_CURRENT_COMMISSION_TERMS/);
 await denied(()=>teamRpc(db,2,"accept_terms",{accepted:true,revision:99,version:"creatornet-team-commission-v1"}),/REVIEW_CURRENT_COMMISSION_TERMS/);
});
test("only the creator appoints or removes managers; managers can manage closers",async()=>{
 const manager=await addTeamMember(db,2,"manager",false), closer=await addTeamMember(db,3);
 await denied(()=>teamRpc(db,2,"invite",{role:"manager"}),/OWNER_REQUIRED/);
 await denied(()=>teamRpc(db,2,"remove_member",{membership_id:manager}),/OWNER_REQUIRED/);
 await teamRpc(db,2,"configure_member",{membership_id:closer,role:"closer",is_closer:true,commission_bps:1500,hold_days:30,renewal_rule:"every_renewal"});
 const member=(await db.query<{commission_revision:number;accepted_commission_revision:number|null}>("select * from public.sales_team_memberships_v1 where id=$1",[closer])).rows[0];
 expect(member).toMatchObject({commission_revision:2,accepted_commission_revision:null});
 expect((await db.query("select * from public.sales_team_commission_terms_v1 where membership_id=$1",[closer])).rows).toHaveLength(2);
});
test("revocation of the inviter invalidates their unaccepted invitation",async()=>{
 const manager=await addTeamMember(db,2,"manager",false);
 await teamRpc(db,2,"invite",{email:"user4@example.test",role:"closer",is_closer:true,commission_bps:1000,hold_days:14,renewal_rule:"initial_commitment",token_hash:"b".repeat(64)});
 await teamRpc(db,1,"remove_member",{membership_id:manager});
 await denied(()=>teamRpc(db,4,"accept_invitation",{token_hash:"b".repeat(64)}),/INVITER_NO_LONGER_AUTHORIZED/);
});
test("weighted routing assigns 1:3 and repeated requests consume no extra turn",async()=>{
 const a=await addTeamMember(db,2),b=await addTeamMember(db,3);const counts=new Map([[a,0],[b,0]]);
 for(let n=1;n<=20;n++){const r=await assign(n);counts.set(r.assignment.membership_id,counts.get(r.assignment.membership_id)!+1);}
 expect(counts.get(a)).toBe(5);expect(counts.get(b)).toBe(15);
 const before=(await db.query("select target_id,route_count from public.sales_team_destination_bindings_v1 order by target_id")).rows;
 const results=await Promise.all([assign(1),assign(1),assign(1)]);expect(results.every(r=>r.reused)).toBe(true);
 expect((await db.query("select target_id,route_count from public.sales_team_destination_bindings_v1 order by target_id")).rows).toEqual(before);
});
test("inactive, zero-weight, unaccepted and payout-ineligible members are excluded",async()=>{
 const a=await addTeamMember(db,2);await addTeamMember(db,3);
 await db.query("update public.booking_targets set weight=0 where id=$1",[id(103)]);
 expect((await assign(1)).assignment.membership_id).toBe(a);
 await db.query("update public.sales_team_recipients_v1 set payouts_ready=false where user_id=$1",[id(2)]);
 await denied(()=>assign(2),/NO_ELIGIBLE_TEAM_DESTINATION/);
 await denied(()=>assign(1),/ASSIGNED_MEMBER_UNAVAILABLE/);
});
test("unknown shared calendars grant no closer access until explicitly bound",async()=>{
 await db.query("insert into public.booking_targets(id,creator_id,booking_url) values($1,$2,'https://calendar.example/shared')",[id(150),id(1)]);
 await denied(()=>assign(1),/NO_ELIGIBLE_TEAM_DESTINATION/);
});
test("only managers reassign, cross-creator and unrelated buyer requests fail",async()=>{
 const a=await addTeamMember(db,2),b=await addTeamMember(db,3);await assign(1,1,a);
 await denied(()=>assign(1,2,b),/TEAM_MANAGER_REQUIRED/);
 await denied(()=>assign(2,11),/BOOKING_UNAVAILABLE/);
 await denied(()=>teamRpc(db,11,"remove_member",{membership_id:a},12),/TEAM_MANAGER_REQUIRED/);
 expect((await assign(1,1,b)).assignment).toMatchObject({membership_id:b,revision:2});
 await db.query("update public.sales_team_assignments_v1 set accepted_sale_id=$1 where booking_id=$2",[id(25),booking(1)]);
 await denied(()=>assign(1,1,a),/SALE_ATTRIBUTION_FROZEN/);
});
test("removal stops new access while preserving assignment and terms history",async()=>{
 const member=await addTeamMember(db,2);await assign(1);
 await teamRpc(db,1,"remove_member",{membership_id:member});
 await denied(()=>assign(2),/NO_ELIGIBLE_TEAM_DESTINATION/);
 expect((await db.query("select * from public.sales_team_assignments_v1")).rows).toHaveLength(1);
 expect((await db.query("select * from public.sales_team_commission_terms_v1")).rows).toHaveLength(1);
});
test("historical payments are never invented as new team assignments",async()=>{
 await addTeamMember(db,2);await db.query("update public.bookings set linked_order_id=$1 where id=$2",[id(25),booking(1)]);
 await denied(()=>assign(1),/HISTORICAL_PAYMENT_NOT_ASSIGNABLE/);
});
test("direct authenticated database writes and service RPCs are denied; RLS scopes memberships",async()=>{
 const a=await addTeamMember(db,2);await addTeamMember(db,3);await assign(1,1,a);
 await db.query("select set_config('request.jwt.claim.sub',$1,true)",[id(2)]);await db.exec("set local role authenticated");
 expect((await db.query("select user_id from public.sales_team_memberships_v1")).rows).toEqual([{user_id:id(2)}]);
 expect((await db.query("select booking_id from public.sales_team_assignments_v1")).rows).toEqual([{booking_id:booking(1)}]);
 await denied(()=>db.query("update public.sales_team_memberships_v1 set role='manager'"),/permission denied/);
 await denied(()=>teamRpc(db,1,"remove_member",{membership_id:a}),/permission denied/);
 await denied(()=>db.query("select * from public.sales_team_recipients_v1"),/permission denied/);
 await db.exec("set local role anon");
 await denied(()=>db.query("select * from public.sales_team_memberships_v1"),/permission denied/);
});
test("service-role transactions have exactly the privileges needed for legitimate operations",async()=>{
 const member=await addTeamMember(db,2);await db.exec("set local role service_role");
 expect((await assign(1)).assignment.membership_id).toBe(member);
});
