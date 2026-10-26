import {NextRequest} from "next/server";
import {readBuyerTeamSale} from "@/lib/salesTeams/checkout";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {teamId,TeamSalesError,teamLifecycleSchemaReady,teamPayoffCollectionReady,teamLaterCollectionReady,teamPaymentCollectionReady} from "@/lib/salesTeams/policy";
import {teamError,teamJson} from "@/lib/salesTeams/server";
import {readTeamExitQuote,requestTeamExit,prepareTeamPayoff,readTeamCollectionOverview,stopTeamCollection,teamCollectionView} from "@/lib/salesTeams/collection";
async function owned(req:NextRequest,params:Promise<{saleId:string}>){
 if(!teamLifecycleSchemaReady())throw new TeamSalesError("TEAM_LIFECYCLE_NOT_ENABLED","Payment plan management is not enabled.",404);
 const {saleId}=await params,{admin,user,sale}=await readBuyerTeamSale(req,saleId);
 if(sale.status!=="accepted")throw new TeamSalesError("ACCEPT_CURRENT_TERMS","An accepted purchase is required.");return {saleId,admin,user};
}
export async function GET(req:NextRequest,{params}:{params:Promise<{saleId:string}>}){
 try{const {saleId,admin,user}=await owned(req,params);return teamJson({quote:await readTeamExitQuote({admin},saleId,user.id),payoffCollectionEnabled:teamPayoffCollectionReady()});}catch(error){return teamError(error);}
}
export async function POST(req:NextRequest,{params}:{params:Promise<{saleId:string}>}){
 try{
  if(req.headers.get("origin")!==new URL(req.url).origin)throw new TeamSalesError("SAME_ORIGIN_REQUIRED","Manage this payment plan from its CreatorNet page.",403);
  const {saleId,admin,user}=await owned(req,params),raw=await req.text();if(raw.length>4096)throw new TeamSalesError("INVALID_TEAM_EXIT","Invalid payment plan action.",400);
  const body=JSON.parse(raw),allowed:Record<string,string[]>={stop_renewal:["action","request_id","accepted"],revoke_debits:["action","request_id","accepted"],prepare_payoff:["action","request_id","accepted","fingerprint"]};
  if(!body||typeof body!=="object"||Array.isArray(body)||!Object.hasOwn(allowed,body.action)||Object.keys(body).some(key=>!allowed[body.action].includes(key))||body.accepted!==true)throw new TeamSalesError("EXPLICIT_TEAM_EXIT_REQUIRED","Confirm the exact payment plan action.",400);
  teamId(body.request_id);
  if(body.action==="prepare_payoff"){
   if(!teamPayoffCollectionReady())throw new TeamSalesError("TEAM_PAYOFF_COLLECTION_HELD","New payoff payments are currently held.");
   if(!/^[a-f0-9]{64}$/.test(body.fingerprint))throw new TeamSalesError("CURRENT_TEAM_PAYOFF_QUOTE_REQUIRED","Refresh and review the current payoff quote.",400);
   const prepared=await prepareTeamPayoff(createTeamPaymentContext(),saleId,user.id,{requestId:body.request_id,fingerprint:body.fingerprint,accepted:true});
   return teamJson({payment:prepared.view,collectionEnabled:teamPayoffCollectionReady(),laterCollectionEnabled:teamLaterCollectionReady(),lifecycleAvailable:true,quote:await readTeamExitQuote({admin},saleId,user.id)});
  }
  const quote=await requestTeamExit({admin},saleId,user.id,{requestId:body.request_id,kind:body.action,accepted:true}),overview=await readTeamCollectionOverview({admin},saleId,user.id),saved=overview.payment;
  const cancelOriginal=body.action==="revoke_debits"||body.action==="stop_renewal"&&saved.obligation&&saved.obligation.period_number>quote.minimumMonths;
  const payment=cancelOriginal&&!saved.receipt?await stopTeamCollection(createTeamPaymentContext(),saleId,user.id,saved.obligation?.id??null):teamCollectionView(saved);
  const payoff=saved.obligation?.payment_kind==="monthly_payoff";
  return teamJson({quote:await readTeamExitQuote({admin},saleId,user.id),payment,collectionEnabled:payoff?teamPayoffCollectionReady():saved.obligation&&saved.obligation.period_number>1?teamLaterCollectionReady():teamPaymentCollectionReady(),laterCollectionEnabled:teamLaterCollectionReady(),lifecycleAvailable:true});
 }catch(error){return teamError(error);}
}
