import {NextRequest} from "next/server";
import {readBuyerTeamSale} from "@/lib/salesTeams/checkout";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {teamId,TeamSalesError,teamCollectionRetrySchemaReady,teamCollectionRetryReady,teamPayoffCollectionReady,teamLaterCollectionReady} from "@/lib/salesTeams/policy";
import {teamError,teamJson} from "@/lib/salesTeams/server";
import {readTeamRetryQuote,prepareTeamCollectionRetry} from "@/lib/salesTeams/collection";
import {savedMethodPaymentResponse} from "@/lib/salesTeams/savedMethod";
async function owned(req:NextRequest,params:Promise<{saleId:string}>){
 if(!teamCollectionRetrySchemaReady())throw new TeamSalesError("TEAM_RETRY_NOT_ENABLED","Manual payment review is not enabled.",404);
 const {saleId}=await params,{admin,user,sale}=await readBuyerTeamSale(req,saleId);if(sale.status!=="accepted")throw new TeamSalesError("ACCEPT_CURRENT_TERMS","An accepted purchase is required.");return {saleId,admin,user};
}
export async function GET(req:NextRequest,{params}:{params:Promise<{saleId:string}>}){
 try{const {saleId,admin,user}=await owned(req,params),value=req.nextUrl.searchParams.get("obligation_id"),original=value===null?null:teamId(value),result=await readTeamRetryQuote({admin},saleId,user.id,original);
  return teamJson({...result,collectionEnabled:teamCollectionRetryReady()&&(result.quote?.paymentKind!=="monthly_payoff"||teamPayoffCollectionReady())});
 }catch(error){return teamError(error);}
}
export async function POST(req:NextRequest,{params}:{params:Promise<{saleId:string}>}){
 try{
  if(req.headers.get("origin")!==new URL(req.url).origin)throw new TeamSalesError("SAME_ORIGIN_REQUIRED","Review this payment from its CreatorNet page.",403);
  const {saleId,admin,user}=await owned(req,params),raw=await req.text();if(raw.length>4096)throw new TeamSalesError("INVALID_TEAM_RETRY","Invalid manual payment review.",400);
  const body=JSON.parse(raw),allowed=["action","request_id","original_obligation_id","fingerprint","accepted"];
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key))||body.action!=="prepare_retry"||body.accepted!==true||!Object.hasOwn(body,"original_obligation_id")||!/^[a-f0-9]{64}$/.test(body.fingerprint))throw new TeamSalesError("EXPLICIT_TEAM_RETRY_REQUIRED","Review and confirm the exact manual payment attempt.",400);
  const requestId=teamId(body.request_id),original=body.original_obligation_id===null?null:teamId(body.original_obligation_id);
  if(!teamCollectionRetryReady())throw new TeamSalesError("TEAM_COLLECTION_RETRY_HELD","New manual payment attempts are currently held.");
  const saved=await admin.from("sales_team_collection_retries_v1").select("sale_id,buyer_id,payment_kind,original_obligation_id,quote_fingerprint").eq("id",requestId).maybeSingle();if(saved.error)throw saved.error;
  let kind:string;
  if(saved.data){if(saved.data.sale_id!==saleId||saved.data.buyer_id!==user.id||saved.data.original_obligation_id!==original||saved.data.quote_fingerprint!==body.fingerprint)throw new TeamSalesError("ORIGINAL_TEAM_RETRY_REQUIRED","View the original admitted manual attempt.");kind=saved.data.payment_kind;}
  else{const current=await readTeamRetryQuote({admin},saleId,user.id,original);if(current.status!=="ready"||!current.quote||current.quote.fingerprint!==body.fingerprint||current.quote.originalObligationId!==original)throw new TeamSalesError("CURRENT_TEAM_RETRY_QUOTE_REQUIRED","Refresh the original payment and review its current manual quote.");kind=current.quote.paymentKind;}
  if(kind==="monthly_payoff"&&!teamPayoffCollectionReady())throw new TeamSalesError("TEAM_PAYOFF_COLLECTION_HELD","New payoff payment attempts are currently held.");
  const prepared=await prepareTeamCollectionRetry(createTeamPaymentContext(),saleId,user.id,{requestId,originalObligationId:original,fingerprint:body.fingerprint,accepted:true});
  return teamJson({payment:prepared.view,collectionEnabled:teamCollectionRetryReady()&&(kind!=="monthly_payoff"||teamPayoffCollectionReady()),laterCollectionEnabled:teamLaterCollectionReady(),lifecycleAvailable:true,retryAvailable:true,...await savedMethodPaymentResponse(admin,saleId,user.id,prepared.view)});
 }catch(error){return teamError(error);}
}
