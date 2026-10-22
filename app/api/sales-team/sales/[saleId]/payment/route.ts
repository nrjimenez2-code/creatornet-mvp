import {NextRequest} from "next/server";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {readBuyerTeamSale,requireTeamCheckout} from "@/lib/salesTeams/checkout";
import {teamId,TeamSalesError,teamPaymentSchemaReady,teamPaymentCollectionReady} from "@/lib/salesTeams/policy";
import {teamError,teamJson} from "@/lib/salesTeams/server";
import {readTeamCollection,teamCollectionView,prepareTeamCollection,confirmTeamCollection,stopTeamCollection} from "@/lib/salesTeams/collection";
async function owned(req:NextRequest,params:Promise<{saleId:string}>){
 if(!teamPaymentSchemaReady())throw new TeamSalesError("TEAM_PAYMENT_NOT_ENABLED","This payment path is not enabled.",404);
 const {saleId}=await params,{admin,user,sale}=await readBuyerTeamSale(req,saleId);
 if(!["accepted","closed_unpaid"].includes(sale.status))throw new TeamSalesError("ACCEPT_CURRENT_TERMS","Accept the current purchase terms before preparing payment.");
 return {saleId,admin,user};
}
export async function GET(req:NextRequest,{params}:{params:Promise<{saleId:string}>}){
 try{const {saleId,admin,user}=await owned(req,params);return teamJson({payment:teamCollectionView(await readTeamCollection({admin},saleId,user.id)),collectionEnabled:teamPaymentCollectionReady()});}
 catch(error){return teamError(error);}
}
export async function POST(req:NextRequest,{params}:{params:Promise<{saleId:string}>}){
 try{
  if(req.headers.get("origin")!==new URL(req.url).origin)throw new TeamSalesError("SAME_ORIGIN_REQUIRED","Continue payment from this CreatorNet page.",403);
  const {saleId,admin,user}=await owned(req,params),raw=await req.text();if(raw.length>4096)throw new TeamSalesError("INVALID_PAYMENT_ACTION","Invalid payment action.",400);
  const body=JSON.parse(raw),action=body?.action;
  const allowed:Record<string,string[]>={prepare:["action"],refresh:["action"],stop:["action"],confirm:["action","request_id","confirmation_token"],reconfirm:["action","request_id"],resume:["action","request_id","confirmation_token"]};
  if(!body||typeof body!=="object"||Array.isArray(body)||!Object.hasOwn(allowed,action)||Object.keys(body).some(key=>!allowed[action].includes(key)))throw new TeamSalesError("INVALID_PAYMENT_ACTION","Invalid payment action.",400);
  if(["prepare","confirm","reconfirm"].includes(action)){requireTeamCheckout();if(!teamPaymentCollectionReady())throw new TeamSalesError("TEAM_PAYMENT_COLLECTION_HELD","New payments are currently held.");}
  if(["confirm","reconfirm","resume"].includes(action))teamId(body.request_id);
  if(action==="confirm"&&!/^ctoken_[A-Za-z0-9]+$/.test(body.confirmation_token))throw new TeamSalesError("INVALID_CONFIRMATION_TOKEN","Enter payment details before confirming.",400);
  const composition=createTeamPaymentContext();let payment;
  if(action==="prepare"||action==="refresh")payment=(await prepareTeamCollection(composition,saleId,user.id,action==="prepare")).view;
  else if(action==="stop")payment=await stopTeamCollection(composition,saleId,user.id);
  else if(action==="resume"){
   const saved=await readTeamCollection({admin},saleId,user.id),request=await admin.from("sales_team_payment_confirmations_v1").select("kind,token_id").eq("obligation_id",saved.obligation?.id??"00000000-0000-0000-0000-000000000000").eq("request_id",body.request_id).maybeSingle();
   if(request.error)throw request.error;
   if(!request.data){
    requireTeamCheckout();if(!teamPaymentCollectionReady()||!/^ctoken_[A-Za-z0-9]+$/.test(body.confirmation_token))throw new TeamSalesError("ORIGINAL_CONFIRMATION_UNAVAILABLE","The original confirmation has not been admitted. Refresh this payment before continuing.");
    payment=await confirmTeamCollection(composition,saleId,user.id,{requestId:body.request_id,kind:"token",tokenId:body.confirmation_token});
   }else{
    if(body.confirmation_token!==undefined&&body.confirmation_token!==request.data.token_id)throw new TeamSalesError("ORIGINAL_TEAM_CONFIRMATION_CHANGED","Resume the original payment confirmation.");
    payment=await confirmTeamCollection(composition,saleId,user.id,{requestId:body.request_id,kind:request.data.kind,tokenId:request.data.token_id,recoveryOnly:true});
   }
  }else payment=await confirmTeamCollection(composition,saleId,user.id,{requestId:body.request_id,kind:action==="confirm"?"token":"reconfirm",...(action==="confirm"?{tokenId:body.confirmation_token}:{})});
  return teamJson({payment,collectionEnabled:teamPaymentCollectionReady()});
 }catch(error){return teamError(error);}
}
