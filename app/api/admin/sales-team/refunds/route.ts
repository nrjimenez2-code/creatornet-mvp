import {NextRequest,NextResponse} from "next/server";
import {requireAdmin,adminAuthErrorResponse} from "@/lib/admin/server";
import {isSameOriginRequest} from "@/lib/sameOrigin";
import {teamRefundDispatchReady,teamRefundDispatchSchemaReady} from "@/lib/salesTeams/policy";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {previewTeamAdminRefund,reserveTeamAdminRefund,processTeamAdminRefund,cancelUnsentTeamRefund,readTeamAdminRefund,teamAdminRefundView} from "@/lib/salesTeams/adminRefunds";
import {isRefundResponsibility,isRefundReasonCode,reasonMatchesResponsibility} from "@/lib/refundAllocation";
export const runtime="nodejs";
const reply=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{"Cache-Control":"private, no-store"}});
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export async function GET(req:NextRequest){
 let actor:Awaited<ReturnType<typeof requireAdmin>>;try{actor=await requireAdmin(req);}catch(error){return adminAuthErrorResponse(error,"team_refund_status");}
 if(!teamRefundDispatchSchemaReady())return reply({error:"Team refund recovery is unavailable."},404);
 const id=req.nextUrl.searchParams.get("request_id");if(!uuid(id))return reply({error:"An original refund request is required."},400);
 try{const q=await readTeamAdminRefund(createTeamPaymentContext(),actor.user.id,id);return q?reply(teamAdminRefundView(q,"saved_status")):reply({error:"Original refund request unavailable."},404);}
 catch{return reply({error:"The original refund still requires review."},409);}
}
export async function POST(req:NextRequest){
 if(!isSameOriginRequest(req))return reply({error:"Invalid request origin"},403);
 let actor:Awaited<ReturnType<typeof requireAdmin>>;try{actor=await requireAdmin(req);}catch(error){return adminAuthErrorResponse(error,"team_refund_action");}
 if(!teamRefundDispatchSchemaReady())return reply({error:"Team refund recovery is unavailable."},404);
 let body:unknown;try{body=await req.json();}catch{return reply({error:"Invalid request"},400);}
 if(!body||typeof body!=="object"||Array.isArray(body))return reply({error:"Invalid request"},400);const b=body as Record<string,unknown>;
 const keys=b.action==="preview"?["action","receiptId","amountCents","responsibility","reasonCode"]:b.action==="create"?["action","receiptId","requestId","amountCents","responsibility","reasonCode","expectedRevision","confirm"]:b.action==="recover"?["action","requestId"]:b.action==="cancel_unsent"?["action","requestId","confirm"]:null;
 if(!keys||Object.keys(b).some(key=>!keys.includes(key)))return reply({error:"Invalid request"},400);
 if(b.action==="recover"||b.action==="cancel_unsent"){
  if(!uuid(b.requestId)||b.action==="cancel_unsent"&&b.confirm!==true)return reply({error:"Confirm the original unstarted request."},400);
  try{return reply(b.action==="recover"?await processTeamAdminRefund(createTeamPaymentContext(),actor.user.id,b.requestId,false):await cancelUnsentTeamRefund(createTeamPaymentContext(),actor.user.id,b.requestId));}
  catch{return reply({error:"The original refund requires recovery. Its financial hold is retained."},409);}
 }
 if(!teamRefundDispatchReady())return reply({error:"New team refunds are currently held."},409);
 if(!uuid(b.receiptId)||!Number.isSafeInteger(b.amountCents)||Number(b.amountCents)<1||Number(b.amountCents)>99999999||!isRefundResponsibility(b.responsibility)||!isRefundReasonCode(b.reasonCode)||!reasonMatchesResponsibility(b.reasonCode,b.responsibility))return reply({error:"Review the exact amount and cost responsibility."},400);
 if(b.action==="create"&&(!uuid(b.requestId)||!Number.isSafeInteger(b.expectedRevision)||Number(b.expectedRevision)<0||b.confirm!==true))return reply({error:"Preview the current totals and confirm this exact refund."},400);
 try{
  const c=createTeamPaymentContext();
  if(b.action==="preview")return reply(await previewTeamAdminRefund(c,actor.user.id,b.receiptId,Number(b.amountCents),b.responsibility,b.reasonCode));
  const q=await reserveTeamAdminRefund(c,{actorId:actor.user.id,requestId:b.requestId as string,receiptId:b.receiptId,expectedRevision:Number(b.expectedRevision),amountCents:Number(b.amountCents),responsibility:b.responsibility,reasonCode:b.reasonCode});
  return reply(await processTeamAdminRefund(c,actor.user.id,q.id,true));
 }catch{return reply({error:"This original refund requires review. Recover its saved request before another action."},409);}
}
