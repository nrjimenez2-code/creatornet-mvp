import "server-only";
import {isDeepStrictEqual} from "node:util";
import type {SupabaseClient} from "@supabase/supabase-js";
import type Stripe from "stripe";
import type {ExactPaymentContext} from "@/lib/installments/paymentContext";
import {runTeamProviderOperation,TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {observeTeamRecipient,recipientCreationRequest,recipientLinkRequest,verifiedRecipientLink,type TeamRecipientSetup} from "./recipientPolicy";
import {teamId,TeamSalesError,type TeamRecipientStatus} from "./policy";
import {teamRpc} from "./server";

type Provider={rawRequest:Stripe["rawRequest"]};
type Composition={admin:SupabaseClient;stripe:Provider;context:ExactPaymentContext;observeContext:()=>Promise<ExactPaymentContext>};
type Json=Record<string,unknown>;
const rec=(value:unknown):Json=>value&&typeof value==="object"&&!Array.isArray(value)?value as Json:{};
const requestId=(value:unknown)=>String(rec(rec(value).lastResponse).requestId||"");
const review=()=>new TeamSalesError("TEAM_RECIPIENT_REVIEW_REQUIRED","Your original payout setup needs review before another request can continue.");
export async function readTeamRecipientStatus(admin:SupabaseClient,userId:string):Promise<TeamRecipientStatus>{
 if(!await teamRpc<boolean>(admin,"sales_team_recipient_allowed_v1",{p_actor_id:userId}))throw new TeamSalesError("TEAM_RECIPIENT_ACCESS_DENIED","Your payout setup is unavailable.",403);
 const result=await admin.from("sales_team_recipients_v1").select("ownership_verified,transfers_active,payouts_ready,verified_at").eq("user_id",userId).maybeSingle();
 if(result.error)throw result.error;
 const row=result.data;if(!row)return {status:"not_started",transfersActive:false,payoutsReady:false,verifiedAt:null};
 const verifiedAt=Date.parse(row.verified_at),now=Date.now();
 const current=await teamRpc<boolean>(admin,"sales_team_recipient_context_current_v1",{p_actor_id:userId});
 const fresh=current===true&&row.ownership_verified&&verifiedAt>now-15*60000&&verifiedAt<=now;
 return {status:!fresh?"verification_required":row.transfers_active&&row.payouts_ready?"ready":"setup_required",
  transfersActive:fresh&&row.transfers_active,payoutsReady:fresh&&row.payouts_ready,verifiedAt:row.verified_at};
}
/** Own identity only. HTTP input never supplies an account ID, email, API
 * version, recipient, return URL or provider creation parameters. */
export async function refreshTeamRecipient(c:Composition,userId:string,admitCreation=false){
 teamId(userId);const observe=async()=>{const started=Date.now();if(!isDeepStrictEqual(await c.observeContext(),c.context)||Date.now()<started||Date.now()-started>=30000)throw review();};await observe();
 if(!await teamRpc<boolean>(c.admin,"sales_team_recipient_allowed_v1",{p_actor_id:userId}))throw review();
 const setup=await teamRpc<TeamRecipientSetup|null>(c.admin,"reserve_sales_team_recipient_v1",{p_actor_id:userId,p_context:c.context,p_admit_creation:admitCreation});
 if(!setup)return {status:await readTeamRecipientStatus(c.admin,userId),setup:null};
 if(setup.user_id!==userId||!isDeepStrictEqual(setup.context,c.context))throw review();
 const saved=setup;
 const retrieve=async(id:string)=>{
  if(!/^acct_[A-Za-z0-9]+$/.test(id))throw review();
  const object=await c.stripe.rawRequest("GET",`${saved.api==="v1"?"/v1/accounts/":"/v2/core/accounts/"}${id}`,
   saved.api==="v2"?{include:["configuration.recipient","defaults","identity","requirements"]}:{},
   {apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000});
  return {id:String(rec(object).id||""),requestId:requestId(object),account:object};
 };
 let original:Awaited<ReturnType<typeof retrieve>>;
 try{
  if(saved.account_id)original=await retrieve(saved.account_id);
  else{
   if(!admitCreation){
    const prior=await c.admin.from("sales_team_provider_operations_v1").select("id").eq("scope_id",userId).eq("kind","recipient").eq("scope_key",`recipient:${saved.id}`).maybeSingle();
    if(prior.error)throw prior.error;
    if(!prior.data)return {status:await readTeamRecipientStatus(c.admin,userId),setup:saved};
   }
   if(saved.api!=="v2"||!saved.request)throw review();
   if(!isDeepStrictEqual(saved.request,recipientCreationRequest(userId,saved.id,String(saved.request.params.contact_email))))throw review();
   const operation=await runTeamProviderOperation({admin:c.admin,context:c.context,observeContext:c.observeContext,
    scope:{scopeId:userId,scopeKey:`recipient:${saved.id}`,kind:"recipient",saleId:null,creatorId:null,actorId:userId},request:saved.request,
    assertSource:async()=>{const fresh=await teamRpc(c.admin,"reserve_sales_team_recipient_v1",{p_actor_id:userId,p_context:c.context,p_admit_creation:true});if(!isDeepStrictEqual(fresh,saved))throw review();},
    create:async(request,options)=>{
     if(!admitCreation)throw review();
     const account=await c.stripe.rawRequest(request.method,request.path,request.params,options);
     return {id:String(rec(account).id||""),requestId:requestId(account),account};
    },retrieve,
    reconcileUnknown:async()=>{
     // A bounded, independently read complete page can prove exactly one
     // original. More pages or multiple matches remain held for reconciliation.
     const page=await c.stripe.rawRequest("GET","/v2/core/accounts",{limit:100},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000});
     const data=rec(page);if(!Array.isArray(data.data)||data.data.length>100||data.next_page_url!==null)return null;
     const candidates=data.data.filter(value=>rec(rec(value).metadata).creatornet_user_id===userId&&rec(rec(value).metadata).creatornet_team_recipient_setup_id===saved.id);
     return candidates.length===1?retrieve(String(rec(candidates[0]).id)):null;
    },validate:object=>{if(rec(object.account).id!==object.id)throw review();observeTeamRecipient(saved,object.account,object.requestId);}});
   if(operation.status!=="bound")throw new TeamSalesError("TEAM_RECIPIENT_RECOVERY_REQUIRED","The original payout setup is still being reconciled. No new account was requested.");
   original=operation.object;
  }
  const observation=observeTeamRecipient(saved,original.account,original.requestId);
  await observe();
  await teamRpc(c.admin,"record_sales_team_recipient_v1",{p_actor_id:userId,p_context:c.context,p_observation:observation});
  return {status:await readTeamRecipientStatus(c.admin,userId),setup:{...saved,account_id:observation.accountId}};
 }catch(error){
  // A failed current verification must not leave a recently cached "ready"
  // record usable by routing. Preserve the original account identity.
  if(saved.account_id){const invalidated=await c.admin.from("sales_team_recipients_v1").update({ownership_verified:false,transfers_active:false,payouts_ready:false,
   evidence:{code:"CURRENT_VERIFICATION_REQUIRED"},updated_at:new Date().toISOString()}).eq("user_id",userId).eq("account_id",saved.account_id);
   if(invalidated.error)throw review();}
  throw error;
 }
}

export async function startTeamRecipientOnboarding(c:Composition,userId:string,requestIdentity:string){
 teamId(requestIdentity);
 const refreshed=await refreshTeamRecipient(c,userId,true),setup=refreshed.setup;if(!setup)throw review();
 if(refreshed.status.status==="ready")return {status:refreshed.status};
 const request=recipientLinkRequest(setup);
 const result=await teamRpc<{status:string;link:Json}>(c.admin,"claim_sales_team_onboarding_link_v1",{p_actor_id:userId,p_request_id:requestIdentity,p_context:c.context,p_request:request});
 if(result.link?.user_id!==userId||!isDeepStrictEqual(result.link?.context,c.context)||!isDeepStrictEqual(result.link?.request,request))throw review();
 if(result.status==="bound"){
  if(Date.parse(String(result.link.expires_at))<=Date.now())throw new TeamSalesError("ONBOARDING_LINK_EXPIRED","This saved setup link expired. Request a new link.");
  const link=verifiedRecipientLink({...setup,api:"v1"},{object:"account_link",url:result.link.url,expires_at:Date.parse(String(result.link.expires_at))/1000});
  return {status:refreshed.status,url:link.url};
 }
 if(result.status!=="dispatch")throw new TeamSalesError("TEAM_RECIPIENT_RECOVERY_REQUIRED","This original setup link is still being reconciled. No additional link was requested.");
 const lease=String(result.link.lease_token);
 if(!isDeepStrictEqual(await c.observeContext(),c.context))throw review();
 await teamRpc(c.admin,"assert_sales_team_onboarding_dispatch_v1",{p_actor_id:userId,p_request_id:requestIdentity,p_lease_token:lease});
 try{
  const object=await c.stripe.rawRequest(request.method,request.path,request.params,
   {apiVersion:TEAM_STRIPE_API_VERSION,idempotencyKey:`cn-team-onboarding-v1:${requestIdentity}`,maxNetworkRetries:0,timeout:10000});
  const link=verifiedRecipientLink(setup,object),proof=requestId(object);if(!/^req_[A-Za-z0-9]+$/.test(proof))throw review();
  if(!isDeepStrictEqual(await c.observeContext(),c.context))throw review();await teamRpc(c.admin,"bind_sales_team_onboarding_link_v1",{p_actor_id:userId,p_request_id:requestIdentity,p_lease_token:lease,p_url:link.url,p_expires_at:link.expiresAt,p_provider_request_id:proof});
  return {status:refreshed.status,url:link.url};
 }catch{
  await teamRpc(c.admin,"mark_sales_team_onboarding_unknown_v1",{p_actor_id:userId,p_request_id:requestIdentity,p_lease_token:lease});
  throw new TeamSalesError("TEAM_RECIPIENT_RECOVERY_REQUIRED","The original setup-link response needs reconciliation. Your saved account was preserved.");
 }
}
