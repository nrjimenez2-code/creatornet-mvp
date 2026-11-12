import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { commissionTerms, teamId, TeamSalesError, teamSalesReady,teamBookedOfferSchemaReady } from "@/lib/salesTeams/policy";
import { teamAccess, teamError, teamJson, teamRequest, teamRpc } from "@/lib/salesTeams/server";
import { getCheckoutSiteUrl } from "@/lib/checkoutSiteUrl";

export async function GET(req:NextRequest){
 try{
  const {admin,user}=await teamRequest(req),creatorInput=req.nextUrl.searchParams.get("creator_id");
  if(!creatorInput){
    const result=await admin.from("sales_team_memberships_v1").select("id,creator_id,role,is_closer,status,commission_bps,hold_days,renewal_rule,commission_revision,accepted_commission_revision").eq("user_id",user.id).order("created_at");
    if(result.error)throw result.error;
    return teamJson({memberships:result.data||[],ownCreatorId:user.id,enabled:teamSalesReady()});
  }
  const creator=teamId(creatorInput),access=await teamAccess(admin,creator,user.id);
  let membersQuery=admin.from("sales_team_memberships_v1").select("id,user_id,role,is_closer,status,commission_bps,hold_days,renewal_rule,commission_revision,accepted_commission_revision").eq("creator_id",creator).order("created_at");
  if(access.role==="closer")membersQuery=membersQuery.eq("user_id",user.id);
  const members=await membersQuery;if(members.error)throw members.error;
  const membershipIds=(members.data||[]).map(m=>m.id);
  const bindings=membershipIds.length?await admin.from("sales_team_destination_bindings_v1").select("target_id,membership_id,route_count,last_assigned_at").eq("creator_id",creator).in("membership_id",membershipIds):{data:[],error:null};
  if(bindings.error)throw bindings.error;
  const invitations=access.role!=="closer"?await admin.from("sales_team_invitations_v1").select("id,email,role,is_closer,commission_bps,hold_days,renewal_rule,expires_at,accepted_at,revoked_at").eq("creator_id",creator).order("created_at",{ascending:false}).limit(100):{data:[],error:null};
  if(invitations.error)throw invitations.error;
  const targets=access.role!=="closer"?await admin.from("booking_targets").select("id,name,booking_url,weight,active,is_active").eq("creator_id",creator):{data:[],error:null};
  if(targets.error)throw targets.error;
  const readiness=await Promise.all((members.data||[]).map(async member=>({membershipId:member.id,ready:await teamRpc<boolean>(admin,"sales_team_member_ready_v1",{p_membership_id:member.id})})));
  const settings=access.role!=="closer"?await admin.from("sales_team_creator_settings_v1").select("routing_enabled").eq("creator_id",creator).maybeSingle():{data:null,error:null};
  if(settings.error)throw settings.error;
  await teamAccess(admin,creator,user.id);
  return teamJson({creatorId:creator,role:access.role,membershipId:access.member?.id||null,members:members.data||[],bookedOffersEnabled:teamBookedOfferSchemaReady(),
    invitations:(invitations.data||[]).map(inv=>({...inv,expired:Date.parse(inv.expires_at)<=Date.now()})),bindings:bindings.data||[],targets:targets.data||[],readiness,routingEnabled:settings.data?.routing_enabled===true,enabled:teamSalesReady()});
 }catch(error){return teamError(error);}
}

export async function POST(req:NextRequest){
 try{
  const {admin,user}=await teamRequest(req,true),body=await req.json(),creator=teamId(body.creator_id);
  const action=body.action as string;let input:Record<string,unknown>;
  if(action==="accept_invitation"){
    if(typeof body.token!=="string"||!/^[a-f0-9]{64}$/.test(body.token))throw new TeamSalesError("INVALID_INVITATION","Use a valid invitation link.",400);
    input={token_hash:createHash("sha256").update(body.token).digest("hex")};
  }else if(action==="accept_terms"){
    input={revision:body.revision,version:body.version,accepted:body.accepted};
  }else{
    const access=await teamAccess(admin,creator,user.id);
    if(!["owner","manager"].includes(access.role))throw new TeamSalesError("TEAM_MANAGER_REQUIRED","Team management permission is required.",403);
    if(action==="invite"||action==="configure_member"){
      if(!["manager","closer"].includes(body.role)||typeof body.is_closer!=="boolean")throw new TeamSalesError("INVALID_TEAM_ROLE","Choose a team role and whether this person can close sales.",400);
      const terms=commissionTerms({commissionBps:body.commission_bps,holdDays:body.hold_days,renewals:body.renewal_rule});
      input={role:body.role,is_closer:body.is_closer,commission_bps:terms.commissionBps,hold_days:terms.holdDays,renewal_rule:terms.renewals};
      if(action==="invite"){
        if(typeof body.email!=="string"||!/^\S+@\S+\.\S+$/.test(body.email)||body.email.length>254||typeof body.token!=="string"||!/^[a-f0-9]{64}$/.test(body.token))throw new TeamSalesError("INVALID_INVITATION","Enter an email and a valid invitation identity.",400);
        input={...input,email:body.email.toLowerCase().trim(),token_hash:createHash("sha256").update(body.token).digest("hex"),invitation_id:teamId(body.request_id)};
      }else{
        if(!Number.isSafeInteger(body.expected_revision)||body.expected_revision<1)throw new TeamSalesError("REVIEW_CURRENT_COMMISSION_TERMS","Refresh the member's current terms before changing them.");
        input.membership_id=teamId(body.membership_id);input.expected_revision=body.expected_revision;
      }
    }else if(action==="remove_member")input={membership_id:teamId(body.membership_id)};
    else if(action==="revoke_invitation")input={invitation_id:teamId(body.invitation_id)};
    else if(action==="bind_destination")input={target_id:teamId(body.target_id),membership_id:teamId(body.membership_id)};
    else if(action==="configure_destination"){
      if(!Number.isInteger(body.weight)||body.weight<0||body.weight>1000||typeof body.enabled!=="boolean")throw new TeamSalesError("INVALID_TEAM_DESTINATION","Choose a weight from 0 to 1000 and whether routing is enabled.",400);
      input={target_id:teamId(body.target_id),weight:body.weight,enabled:body.enabled};
    }
    else if(action==="configure_routing"&&typeof body.enabled==="boolean")input={enabled:body.enabled};
    else throw new TeamSalesError("UNKNOWN_TEAM_ACTION","Choose a supported team action.",400);
  }
  const result=await teamRpc(admin,"manage_sales_team_v1",{p_creator_id:creator,p_actor_id:user.id,p_action:action,p_input:input});
  const invitationUrl=action==="invite"?new URL(`/dashboard/closers/team?creator_id=${encodeURIComponent(creator)}&invitation=${encodeURIComponent(body.token)}`,getCheckoutSiteUrl()).toString():undefined;
  return teamJson({result,...(invitationUrl?{invitationUrl}:{})});
 }catch(error){return teamError(error);}
}
