import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabaseClient";
import { allowRequest } from "@/lib/rateLimit";
import { TeamSalesError, teamId, teamSchemaReady, teamSalesReady, type TeamRole, type MembershipAccess } from "./policy";

export const teamJson = (data: unknown, status=200) => NextResponse.json(data,{status,headers:{"Cache-Control":"private, no-store"}});
export function teamError(error:unknown) {
  if(error instanceof TeamSalesError) return teamJson({error:error.message,code:error.code},error.status);
  const code=String((error as {message?:string})?.message||"");
  const known:Record<string,string>={TEAM_ACCESS_DISABLED:"Team access is not enabled.",TEAM_SALES_DISABLED:"New team sales are not enabled.",
    OWNER_REQUIRED:"Only the creator can appoint or remove managers.",TEAM_MANAGER_REQUIRED:"Team management permission is required.",
    NO_ELIGIBLE_TEAM_DESTINATION:"No eligible closer has an active, linked booking destination.",ASSIGNED_MEMBER_UNAVAILABLE:"This booking needs manager reassignment before routing.",
    SALE_ATTRIBUTION_FROZEN:"This sale was accepted. Its closer attribution is fixed.",HISTORICAL_PAYMENT_NOT_ASSIGNABLE:"Existing payments cannot receive new commission attribution.",
    REVIEW_CURRENT_COMMISSION_TERMS:"Review and accept the current commission terms.",INVITATION_UNAVAILABLE:"This invitation is unavailable or belongs to another verified email.",
    INVITER_NO_LONGER_AUTHORIZED:"The invitation's sender no longer has permission. Request a new invitation.",
    DESTINATION_MEMBER_MISMATCH:"Choose a destination and closer from this creator's team.",MEMBER_ALREADY_EXISTS:"This person is already a member of the team."};
  const match=Object.keys(known).find(key=>code.includes(key));
  if(match)return teamJson({error:known[match],code:match},match==="OWNER_REQUIRED"||match==="TEAM_MANAGER_REQUIRED"?403:409);
  console.error("[sales-team] operation failed",{code:(error as {code?:string})?.code});
  return teamJson({error:"The team operation needs review. Refresh the team to check its current state.",code:"TEAM_REVIEW_REQUIRED"},409);
}
export async function teamRequest(req:NextRequest,mutation=false) {
  if(!teamSchemaReady())throw new TeamSalesError("TEAM_NOT_ENABLED","Sales teams are not enabled.",404);
  if(mutation&&!teamSalesReady())throw new TeamSalesError("TEAM_SALES_DISABLED","New team activity is not enabled.");
  if(mutation&&req.headers.get("origin")!==new URL(req.url).origin)throw new TeamSalesError("SAME_ORIGIN_REQUIRED","Use this CreatorNet page to make changes.",403);
  const admin=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
  const header=req.headers.get("authorization");
  const auth=header ? await admin.auth.getUser(header.match(/^Bearer (\S+)$/i)?.[1]||"invalid")
    : await (await createServerSupabase()).auth.getUser();
  if(auth.error||!auth.data.user)throw new TeamSalesError("UNAUTHORIZED","Sign in to continue.",401);
  const user=auth.data.user;
  if(!allowRequest(`sales-team:${user.id}`,{limit:60,windowMs:60000}))throw new TeamSalesError("RATE_LIMITED","Please wait before trying again.",429);
  return {admin,user};
}
export async function teamRpc<T>(admin:SupabaseClient,name:string,args:Record<string,unknown>):Promise<T>{
  const result=await admin.rpc(name,args);if(result.error)throw result.error;return result.data as T;
}
export async function teamAccess(admin:SupabaseClient,creator:string,actor:string) {
  const role=await teamRpc<TeamRole|null>(admin,"sales_team_actor_role_v1",{p_creator_id:teamId(creator),p_actor_id:actor});
  if(!role)throw new TeamSalesError("TEAM_ACCESS_DENIED","This creator's team is unavailable.",403);
  let member:MembershipAccess|null=null;
  if(role!=="owner"){
    const response=await admin.from("sales_team_memberships_v1").select("*").eq("creator_id",creator).eq("user_id",actor).eq("status","active").maybeSingle();
    if(response.error||!response.data)throw new TeamSalesError("TEAM_ACCESS_DENIED","Your team access has changed.",403);
    member=response.data as MembershipAccess;
  }
  return {role,member};
}
export async function requireCloserReady(admin:SupabaseClient,member:MembershipAccess|null){
  if(!member||!await teamRpc<boolean>(admin,"sales_team_member_ready_v1",{p_membership_id:member.id}))
    throw new TeamSalesError("CLOSER_SETUP_REQUIRED","Accept the current commission terms and complete payout setup before accessing customer bookings.",403);
}

/** Only these customer/offer fields reach a closer. Creator accounting and
 * payment-provider objects stay out of their customer response. */
export async function readTeamBookings(req:NextRequest){
  try{
    const {admin,user}=await teamRequest(req),creator=teamId(req.nextUrl.searchParams.get("creator_id"));
    const {role,member}=await teamAccess(admin,creator,user.id);
    let assigned:string[]|null=null;
    if(role==="closer"){
      await requireCloserReady(admin,member);
      const response=await admin.from("sales_team_assignments_v1").select("booking_id").eq("creator_id",creator).eq("membership_id",member!.id).limit(100);
      if(response.error)throw response.error;assigned=(response.data||[]).map(row=>row.booking_id);
      if(!assigned.length)return teamJson({bookings:[],role});
    }
    let query=admin.from("bookings").select("id,post_id,buyer_id,creator_id,status,linked_order_id,created_at").eq("creator_id",creator).order("created_at",{ascending:false}).limit(100);
    if(assigned)query=query.in("id",assigned);
    const response=await query;if(response.error)throw response.error;
    const bookings=response.data||[],ids=bookings.map(b=>b.id),posts=[...new Set(bookings.map(b=>b.post_id))],buyers=[...new Set(bookings.map(b=>b.buyer_id))];
    if(!bookings.length)return teamJson({bookings:[],role});
    const [assignmentRows,postRows,buyerRows]=await Promise.all([
      admin.from("sales_team_assignments_v1").select("booking_id,membership_id,target_id,source,assigned_at,revision,accepted_sale_id").eq("creator_id",creator).in("booking_id",ids),
      admin.from("posts").select("id,title,product_id,product_type,price_cents").eq("creator_id",creator).in("id",posts),
      admin.from("profiles").select("id,username,full_name,avatar_url").in("id",buyers),
    ]);
    for(const result of [assignmentRows,postRows,buyerRows])if(result.error)throw result.error;
    // Recheck revocation and assignment before returning customer details.
    const current=await teamAccess(admin,creator,user.id);
    if(current.role!==role||current.member?.id!==member?.id)throw new TeamSalesError("TEAM_ACCESS_CHANGED","Your team access has changed.",403);
    if(role==="closer")await requireCloserReady(admin,current.member);
    const assignments=new Map((assignmentRows.data||[]).map(row=>[row.booking_id,row]));
    return teamJson({role,bookings:bookings.filter(b=>role!=="closer"||assignments.get(b.id)?.membership_id===member?.id).map(booking=>({
      booking,assignment:assignments.get(booking.id)||null,post:postRows.data?.find(p=>p.id===booking.post_id)||null,
      buyer:buyerRows.data?.find(b=>b.id===booking.buyer_id)||null,
    }))});
  }catch(error){return teamError(error);}
}
