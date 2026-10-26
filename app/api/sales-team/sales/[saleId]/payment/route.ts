import {NextRequest} from "next/server";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {readBuyerTeamSale,requireTeamCheckout} from "@/lib/salesTeams/checkout";
import {teamId,TeamSalesError,teamPaymentSchemaReady,teamPaymentCollectionReady,teamReceiptRecordingReady,teamFulfillmentReady,teamLaterCollectionSchemaReady,teamLaterCollectionReady,teamPayoffCollectionReady,teamLifecycleSchemaReady} from "@/lib/salesTeams/policy";
import {teamError,teamJson,teamRpc} from "@/lib/salesTeams/server";
import {readTeamCollection,readTeamCollectionOverview,teamCollectionView,prepareTeamCollection,prepareNextTeamCollection,confirmTeamCollection,stopTeamCollection} from "@/lib/salesTeams/collection";
import {recordTeamCapture} from "@/lib/salesTeams/receipts";
async function owned(req:NextRequest,params:Promise<{saleId:string}>){
 if(!teamPaymentSchemaReady())throw new TeamSalesError("TEAM_PAYMENT_NOT_ENABLED","This payment path is not enabled.",404);
 const {saleId}=await params,{admin,user,sale}=await readBuyerTeamSale(req,saleId);
 if(!["accepted","closed_unpaid"].includes(sale.status))throw new TeamSalesError("ACCEPT_CURRENT_TERMS","Accept the current purchase terms before preparing payment.");
 return {saleId,admin,user};
}
export async function GET(req:NextRequest,{params}:{params:Promise<{saleId:string}>}){
 try{const {saleId,admin,user}=await owned(req,params);
  if(teamLaterCollectionSchemaReady()){
   const overview=await readTeamCollectionOverview({admin},saleId,user.id);return teamJson({payment:teamCollectionView(overview.payment),collectionEnabled:overview.payment.obligation?.payment_kind==="monthly_payoff"?teamPayoffCollectionReady():overview.payment.obligation&&overview.payment.obligation.period_number>1?teamLaterCollectionReady():teamPaymentCollectionReady(),nextPayment:overview.nextPayment,laterCollectionEnabled:teamLaterCollectionReady(),...(teamLifecycleSchemaReady()?{lifecycleAvailable:true}:{})});
  }
  return teamJson({payment:teamCollectionView(await readTeamCollection({admin},saleId,user.id)),collectionEnabled:teamPaymentCollectionReady()});}
 catch(error){return teamError(error);}
}
export async function POST(req:NextRequest,{params}:{params:Promise<{saleId:string}>}){
 try{
  if(req.headers.get("origin")!==new URL(req.url).origin)throw new TeamSalesError("SAME_ORIGIN_REQUIRED","Continue payment from this CreatorNet page.",403);
  const {saleId,admin,user}=await owned(req,params),raw=await req.text();if(raw.length>4096)throw new TeamSalesError("INVALID_PAYMENT_ACTION","Invalid payment action.",400);
  const body=JSON.parse(raw),action=body?.action;
  const allowed:Record<string,string[]>={prepare:["action","obligation_id"],prepare_next:["action"],refresh:["action","obligation_id"],stop:["action","obligation_id"],confirm:["action","request_id","confirmation_token","obligation_id"],reconfirm:["action","request_id","obligation_id"],resume:["action","request_id","confirmation_token","obligation_id"]};
  if(!body||typeof body!=="object"||Array.isArray(body)||!Object.hasOwn(allowed,action)||Object.keys(body).some(key=>!allowed[action].includes(key)))throw new TeamSalesError("INVALID_PAYMENT_ACTION","Invalid payment action.",400);
  let obligationId=body.obligation_id===undefined?null:teamId(body.obligation_id);
  const target=():[]|[string]=>obligationId?[obligationId]:[];
  if((obligationId||action==="prepare_next")&&!teamLaterCollectionSchemaReady())throw new TeamSalesError("TEAM_LATER_COLLECTION_NOT_ENABLED","Later payments are not enabled.",404);
  const selected=obligationId?await readTeamCollection({admin},saleId,user.id,obligationId):null,payoff=selected?.obligation?.payment_kind==="monthly_payoff"||selected?.attempt?.contract.kind==="monthly_payoff";
  const assertNew=()=>{if(!obligationId&&action!=="prepare_next")requireTeamCheckout();const ready=payoff?teamPayoffCollectionReady():obligationId||action==="prepare_next"?teamLaterCollectionReady():teamPaymentCollectionReady();if(!ready)throw new TeamSalesError("TEAM_PAYMENT_COLLECTION_HELD","New payments are currently held.");};
  if(["prepare","prepare_next","confirm","reconfirm"].includes(action))assertNew();
  if(["confirm","reconfirm","resume"].includes(action))teamId(body.request_id);
  if(action==="confirm"&&!/^ctoken_[A-Za-z0-9]+$/.test(body.confirmation_token))throw new TeamSalesError("INVALID_CONFIRMATION_TOKEN","Enter payment details before confirming.",400);
  const composition=createTeamPaymentContext();let payment;
  if(action==="prepare_next"){const prepared=await prepareNextTeamCollection(composition,saleId,user.id);payment=prepared.view;if(prepared.saved.obligation&&prepared.saved.obligation.period_number>1)obligationId=prepared.saved.obligation.id;}
  else if(action==="prepare"||action==="refresh")payment=(await prepareTeamCollection(composition,saleId,user.id,action==="prepare",...target())).view;
  else if(action==="stop")payment=await stopTeamCollection(composition,saleId,user.id,...target());
  else if(action==="resume"){
   const saved=await readTeamCollection({admin},saleId,user.id,...target()),request=await admin.from("sales_team_payment_confirmations_v1").select("kind,token_id").eq("obligation_id",saved.obligation?.id??"00000000-0000-0000-0000-000000000000").eq("request_id",body.request_id).maybeSingle();
   if(request.error)throw request.error;
   if(!request.data){
    assertNew();if(!/^ctoken_[A-Za-z0-9]+$/.test(body.confirmation_token))throw new TeamSalesError("ORIGINAL_CONFIRMATION_UNAVAILABLE","The original confirmation has not been admitted. Refresh this payment before continuing.");
    payment=await confirmTeamCollection(composition,saleId,user.id,{requestId:body.request_id,kind:"token",tokenId:body.confirmation_token,...(obligationId?{obligationId}:{})});
   }else{
    if(body.confirmation_token!==undefined&&body.confirmation_token!==request.data.token_id)throw new TeamSalesError("ORIGINAL_TEAM_CONFIRMATION_CHANGED","Resume the original payment confirmation.");
    payment=await confirmTeamCollection(composition,saleId,user.id,{requestId:body.request_id,kind:request.data.kind,tokenId:request.data.token_id,recoveryOnly:true,...(obligationId?{obligationId}:{})});
   }
  }else payment=await confirmTeamCollection(composition,saleId,user.id,{requestId:body.request_id,kind:action==="confirm"?"token":"reconfirm",...(action==="confirm"?{tokenId:body.confirmation_token}:{}),...(obligationId?{obligationId}:{})});
  if(["captured_pending_receipt","receipt_verified","payment_review","paid"].includes(payment.phase)&&teamReceiptRecordingReady()){
   const receipt=await recordTeamCapture(composition,saleId,user.id,...target());
   if((receipt.status==="verified"||receipt.status==="verified_held")&&teamFulfillmentReady())await teamRpc(composition.admin,"fulfill_sales_team_receipt_v1",{p_sale_id:saleId,p_buyer_id:user.id,p_receipt_id:receipt.receiptId});
   payment=teamCollectionView(await readTeamCollection(composition,saleId,user.id,...target()));
  }
  const overview=teamLaterCollectionSchemaReady()?await readTeamCollectionOverview({admin},saleId,user.id):null;
  return teamJson({payment,collectionEnabled:payoff?teamPayoffCollectionReady():obligationId?teamLaterCollectionReady():teamPaymentCollectionReady(),...(overview?{nextPayment:overview.nextPayment,laterCollectionEnabled:teamLaterCollectionReady()}:{}),...(teamLifecycleSchemaReady()?{lifecycleAvailable:true}:{})});
 }catch(error){return teamError(error);}
}
