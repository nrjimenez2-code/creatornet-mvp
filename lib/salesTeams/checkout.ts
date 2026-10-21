import "server-only";
import type { NextRequest } from "next/server";
import { isDeepStrictEqual } from "node:util";
import { purchasePoliciesActive } from "@/lib/purchasePolicies";
import { teamCheckoutReady,teamId,teamSaleSchemaReady,TeamSalesError } from "./policy";
import { publicTeamSaleTerms,quoteTeamSale,type TeamSaleSource,type TeamSaleTerms } from "./agreement";
import { teamError,teamJson,teamRequest,teamRpc } from "./server";

export function requireTeamCheckout(){
 if(!teamCheckoutReady()||!purchasePoliciesActive(process.env))throw new TeamSalesError("TEAM_CHECKOUT_HELD","This approved sales checkout is not enabled yet.");
}
export async function prepareTeamCheckout(req:NextRequest,bookingId:string){
 try{
  const {admin,user}=await teamRequest(req,true);requireTeamCheckout();
  const body=await req.json(),optionId=teamId(body.approved_option_id),requestId=teamId(body.request_id);teamId(bookingId);
  const source=await teamRpc<TeamSaleSource>(admin,"read_sales_team_sale_source_v1",{p_booking_id:bookingId,p_actor_id:user.id,p_option_id:optionId});
  const quote=quoteTeamSale(source,requestId);
  await teamRpc(admin,"prepare_sales_team_sale_v1",{p_request_id:requestId,p_booking_id:bookingId,p_actor_id:user.id,p_option_id:optionId,
   p_source:source,p_terms:quote.terms,p_fingerprint:quote.fingerprint});
  return teamJson({sale_id:requestId,url:new URL(`/purchase/team/${encodeURIComponent(requestId)}`,source.financialConfig.context.siteOrigin).toString(),requires_consent:true});
 }catch(error){return teamError(error);}
}

export type SavedTeamSale={id:string;booking_id:string;creator_id:string;buyer_id:string;prepared_by:string;option_id:string;
 source_snapshot:TeamSaleSource;terms:TeamSaleTerms;fingerprint:string;status:string;expires_at:string};
export async function readBuyerTeamSale(req:NextRequest,saleId:string){
 if(!teamSaleSchemaReady())throw new TeamSalesError("TEAM_SALES_NOT_ENABLED","Sales checkout is not enabled.",404);
 const {admin,user}=await teamRequest(req);teamId(saleId);
 const result=await admin.from("sales_team_sale_requests_v1").select("*").eq("id",saleId).eq("buyer_id",user.id).maybeSingle();
 if(result.error||!result.data)throw new TeamSalesError("SALE_UNAVAILABLE","This buyer review is unavailable.",404);
 const sale=result.data as SavedTeamSale;
 if(sale.status==="review"){
  if(Date.parse(sale.expires_at)<=Date.now())throw new TeamSalesError("SALE_REVIEW_EXPIRED","Ask your closer for a refreshed review.");
  const fresh=await teamRpc<TeamSaleSource>(admin,"read_sales_team_sale_source_v1",{p_booking_id:sale.booking_id,p_actor_id:sale.prepared_by,p_option_id:sale.option_id});
  const quote=quoteTeamSale(fresh,sale.id);
  if(!isDeepStrictEqual(fresh,sale.source_snapshot)||quote.fingerprint!==sale.fingerprint||!isDeepStrictEqual(quote.terms,sale.terms))
   throw new TeamSalesError("SALE_TERMS_CHANGED","The approved terms changed. Ask your closer for a refreshed review.");
 }else if(sale.status!=="accepted")throw new TeamSalesError("SALE_REVIEW_REPLACED","This option was replaced. Ask your closer for the current review.");
 return {admin,user,sale,publicTerms:publicTeamSaleTerms(sale.terms)};
}
