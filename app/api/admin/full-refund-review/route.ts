import {NextRequest,NextResponse} from "next/server";
import {requireAdmin,adminAuthErrorResponse} from "@/lib/admin/server";
import {fullRefundReviewAcknowledgementReady,parseRefundReviewAcknowledgement,acknowledgeFullRefundReview} from "@/lib/fullRefundReviewAcknowledgement";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const json=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store","Vary":"Cookie, Authorization"}});
export async function POST(req:NextRequest){
  if(!process.env.NEXT_PUBLIC_SITE_URL||req.headers.get("origin")!==process.env.NEXT_PUBLIC_SITE_URL||req.nextUrl.origin!==process.env.NEXT_PUBLIC_SITE_URL)
    return json({error:"Invalid request origin."},403);
  let context:Awaited<ReturnType<typeof requireAdmin>>;
  try{context=await requireAdmin(req);}catch(error){return adminAuthErrorResponse(error,"acknowledge_full_refund_review");}
  if(!fullRefundReviewAcknowledgementReady())return json({error:"Refund review acknowledgement is not enabled."},404);
  let body:unknown;try{body=await req.json();}catch{return json({error:"Invalid review request."},400);}
  const input=parseRefundReviewAcknowledgement(body);if(!input)return json({error:"Confirm the exact review and retained hold."},400);
  try{return json(await acknowledgeFullRefundReview(context.admin,context.user.id,input));}
  catch{return json({error:"Review recording needs verification. Refresh the original event before retrying. Its financial hold remains required."},409);}
}
