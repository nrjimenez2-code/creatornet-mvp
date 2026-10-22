import "server-only";
import type { ExactPaymentContext } from "@/lib/installments/paymentContext";
import { TEAM_STRIPE_API_VERSION,type TeamProviderRequest } from "./providerOperation";
import { teamId,TeamSalesError } from "./policy";

export type TeamRecipientSetup={user_id:string;id:string;api:"v1"|"v2";account_id:string|null;
 legacy_creation_key:string|null;context:ExactPaymentContext;request:TeamProviderRequest|null};
export type RecipientObservation={accountId:string;country:"US";currency:"usd";transfersActive:boolean;payoutsReady:boolean;
 ownershipVerified:true;requestId:string;api:"v1"|"v2"};
type Json=Record<string,unknown>;
const rec=(value:unknown):Json=>value&&typeof value==="object"&&!Array.isArray(value)?value as Json:{};
const invalid=()=>new TeamSalesError("TEAM_RECIPIENT_REVIEW_REQUIRED","Your saved payout account needs independent verification before it can be used.");
const capabilityActive=(value:Json)=>{
 // An unrequested nullable capability is a held recipient, never payout proof.
 if(!Object.keys(value).length)return false;
 if(!["active","pending","restricted","unsupported"].includes(String(value.status)))throw invalid();
 return value.status==="active";
};
export function recipientCreationRequest(userId:string,setupId:string,email:string):TeamProviderRequest{
 teamId(userId);teamId(setupId);
 if(typeof email!=="string"||email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw invalid();
 return {apiVersion:TEAM_STRIPE_API_VERSION,method:"POST",path:"/v2/core/accounts",params:{contact_email:email,
  identity:{country:"us"},defaults:{currency:"usd",responsibilities:{fees_collector:"application",losses_collector:"application"}},
  dashboard:"express",configuration:{recipient:{capabilities:{stripe_balance:{stripe_transfers:{requested:true}}}}},
  metadata:{creatornet_user_id:userId,creatornet_team_recipient_setup_id:setupId},
  include:["configuration.recipient","defaults","identity","requirements"]}};
}
/** V1 Accounts do not carry a livemode field. Their provenance comes from the
 * original durable creation row, account metadata, and a platform-scoped GET
 * under an independently observed exact context, rather than an invented flag.
 * Return/refresh URLs and editable profile fields never establish readiness. */
export function observeTeamRecipient(setup:TeamRecipientSetup,object:unknown,requestId:string):RecipientObservation{
 const account=rec(object),metadata=rec(account.metadata);
 if(!/^req_[A-Za-z0-9]+$/.test(requestId)||typeof account.id!=="string"||!/^acct_[A-Za-z0-9]+$/.test(account.id)||
  (setup.account_id&&account.id!==setup.account_id)||account.id===setup.context.platformAccountId||account.deleted===true||metadata.creatornet_user_id!==setup.user_id)throw invalid();
 if(setup.api==="v1"){
  if(account.object!=="account"||!setup.legacy_creation_key||metadata.creatornet_creation_id!==setup.legacy_creation_key||
   account.country!=="US"||account.default_currency!=="usd"||typeof account.payouts_enabled!=="boolean")throw invalid();
  return {accountId:account.id,country:"US",currency:"usd",transfersActive:rec(account.capabilities).transfers==="active",
   payoutsReady:account.payouts_enabled,ownershipVerified:true,requestId,api:"v1"};
 }
 const defaults=rec(account.defaults),identity=rec(account.identity),configuration=rec(account.configuration),recipient=rec(configuration.recipient);
 const balance=rec(rec(recipient.capabilities).stripe_balance),transfers=rec(balance.stripe_transfers),payouts=rec(balance.payouts);
 if(account.object!=="v2.core.account"||account.livemode!==(setup.context.mode==="live")||metadata.creatornet_team_recipient_setup_id!==setup.id||
  identity.country!=="US"||defaults.currency!=="usd"||account.dashboard!=="express"||
  rec(defaults.responsibilities).fees_collector!=="application"||rec(defaults.responsibilities).losses_collector!=="application"||
  !Array.isArray(account.applied_configurations)||!account.applied_configurations.includes("recipient")||typeof recipient.applied!=="boolean")throw invalid();
 const transfersActive=capabilityActive(transfers),payoutsReady=capabilityActive(payouts);
 return {accountId:account.id,country:"US",currency:"usd",transfersActive:recipient.applied&&transfersActive,payoutsReady:recipient.applied&&payoutsReady,
  ownershipVerified:true,requestId,api:"v2"};
}

/** Hosted setup links have no provider object ID. They use a separate durable
 * request record; an application UUID must not be labelled as a Stripe ID. */
export function recipientLinkRequest(setup:TeamRecipientSetup):TeamProviderRequest{
 if(!setup.account_id||!/^acct_[A-Za-z0-9]+$/.test(setup.account_id))throw invalid();
 const url=new URL("/dashboard/closers/payouts",setup.context.siteOrigin);
 const refresh=new URL(url);refresh.searchParams.set("setup","refresh");
 const returned=new URL(url);returned.searchParams.set("setup","return");
 return {apiVersion:TEAM_STRIPE_API_VERSION,method:"POST",path:setup.api==="v1"?"/v1/account_links":"/v2/core/account_links",
  params:setup.api==="v1"?{account:setup.account_id,type:"account_onboarding",refresh_url:refresh.toString(),return_url:returned.toString()}:
   {account:setup.account_id,use_case:{type:"account_onboarding",account_onboarding:{configurations:["recipient"],refresh_url:refresh.toString(),return_url:returned.toString()}}}};
}
export function verifiedRecipientLink(setup:TeamRecipientSetup,value:unknown,now=Date.now()){
 const link=rec(value);let expires:number,url:URL;
 try{url=new URL(String(link.url));expires=setup.api==="v1"?Number(link.expires_at)*1000:Date.parse(String(link.expires_at));}catch{throw invalid();}
 if(!Number.isFinite(expires)||expires<=now||expires>now+3600000||url.protocol!=="https:"||url.hostname!=="connect.stripe.com"&&url.hostname!=="accounts.stripe.com"||
  url.username||url.password||url.port||setup.api==="v1"&&link.object!=="account_link"||setup.api==="v2"&&(link.object!=="v2.core.account_link"||link.account!==setup.account_id||link.livemode!==(setup.context.mode==="live")))throw invalid();
 return {url:url.toString(),expiresAt:new Date(expires).toISOString()};
}
