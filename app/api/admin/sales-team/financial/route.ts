import {NextRequest,NextResponse} from "next/server";
import {requireAdmin,adminAuthErrorResponse} from "@/lib/admin/server";
import {isSameOriginRequest} from "@/lib/sameOrigin";
import {teamFinancialReconciliationReady,teamRefundReviewReady} from "@/lib/salesTeams/policy";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {inspectTeamReceiptFinancials,reviewTeamRefundResponsibility} from "@/lib/salesTeams/financialChecks";
import {isRefundReasonCode,isRefundResponsibility,reasonMatchesResponsibility} from "@/lib/refundAllocation";
export const runtime="nodejs";
const reply=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{"Cache-Control":"no-store"}});

export async function POST(req:NextRequest){
 if(!isSameOriginRequest(req))return reply({error:"Invalid request origin"},403);
 let actor:Awaited<ReturnType<typeof requireAdmin>>;
 try{actor=await requireAdmin(req);}catch(error){return adminAuthErrorResponse(error,"team_financial_inspection");}
 if(!teamFinancialReconciliationReady())return reply({error:"Team financial reconciliation is held."},409);
 let body:unknown;try{body=await req.json();}catch{return reply({error:"Invalid request"},400);}
 if(!body||typeof body!=="object"||Array.isArray(body))return reply({error:"Invalid request"},400);
 const b=body as Record<string,unknown>,uuid=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
 if(!uuid(b.receiptId)||!uuid(b.requestId))return reply({error:"An original receipt and request identity are required."},400);
 const keys=b.action==="inspect"?["action","receiptId","requestId"]:["action","receiptId","requestId","expectedRevision","refundId","responsibility","reasonCode"];
 if(Object.keys(b).some(k=>!keys.includes(k)))return reply({error:"Invalid request"},400);
 try{
  if(b.action==="inspect")return reply(await inspectTeamReceiptFinancials(createTeamPaymentContext(),b.receiptId,actor.user.id,b.requestId));
  if(b.action!=="review_refund"||typeof b.refundId!=="string"||!/^re_[A-Za-z0-9]+$/.test(b.refundId)||!Number.isSafeInteger(b.expectedRevision)||Number(b.expectedRevision)<0||!isRefundResponsibility(b.responsibility)||!isRefundReasonCode(b.reasonCode)||!reasonMatchesResponsibility(b.reasonCode,b.responsibility))return reply({error:"Invalid responsibility review"},400);
  if(!teamRefundReviewReady())return reply({error:"Team refund responsibility review is held."},409);
  return reply(await reviewTeamRefundResponsibility(createTeamPaymentContext(),{actorId:actor.user.id,receiptId:b.receiptId,requestId:b.requestId,expectedRevision:b.expectedRevision as number,refundId:b.refundId,responsibility:b.responsibility,reasonCode:b.reasonCode}));
 }catch{return reply({error:"The original financial inspection requires review; its hold is retained."},409);}
}
