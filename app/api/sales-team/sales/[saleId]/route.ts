import { NextRequest } from "next/server";
import { TeamSalesError } from "@/lib/salesTeams/policy";
import { teamError,teamJson,teamRpc } from "@/lib/salesTeams/server";
import { readBuyerTeamSale,requireTeamCheckout } from "@/lib/salesTeams/checkout";

export async function GET(req:NextRequest,context:{params:Promise<{saleId:string}>}){
 try{
  const {saleId}=await context.params;const {sale,publicTerms}=await readBuyerTeamSale(req,saleId);
  return teamJson({saleId,terms:publicTerms,fingerprint:sale.fingerprint,status:sale.status});
 }catch(error){return teamError(error);}
}
export async function POST(req:NextRequest,context:{params:Promise<{saleId:string}>}){
 try{
  if(req.headers.get("origin")!==new URL(req.url).origin)throw new TeamSalesError("SAME_ORIGIN_REQUIRED","Accept terms from the CreatorNet review page.",403);
  const {saleId}=await context.params;const {admin,user,sale}=await readBuyerTeamSale(req,saleId);const body=await req.json();
  if(sale.status==="closed_unpaid")throw new TeamSalesError("SALE_CLOSED_UNPAID","This payment was safely closed unpaid. Request a new review for another option.");
  if(body.accepted!==true||body.fingerprint!==sale.fingerprint||body.version!==sale.terms.version||Object.keys(body).some(key=>!["accepted","fingerprint","version"].includes(key)))
   throw new TeamSalesError("REVIEW_CURRENT_SALE_TERMS","Review and accept the current terms.");
  if(sale.status!=="accepted")requireTeamCheckout();
  await teamRpc(admin,"accept_sales_team_sale_v1",{p_request_id:saleId,p_buyer_id:user.id,p_fingerprint:body.fingerprint,p_accepted:true});
  return teamJson({saleId,status:"accepted"});
 }catch(error){return teamError(error);}
}
