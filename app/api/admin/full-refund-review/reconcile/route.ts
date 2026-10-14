import {NextRequest,NextResponse} from "next/server";
import {requireAdmin,adminAuthErrorResponse} from "@/lib/admin/server";
import {fullRefundReviewReconciliationReady,parseRefundReviewReconciliation,reconcileFullRefundReview} from "@/lib/fullRefundReviewReconciliation";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const json=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store","Vary":"Cookie, Authorization"}});
export async function POST(req:NextRequest){
  if(!process.env.NEXT_PUBLIC_SITE_URL||req.headers.get("origin")!==process.env.NEXT_PUBLIC_SITE_URL||req.nextUrl.origin!==process.env.NEXT_PUBLIC_SITE_URL)
    return json({error:"Invalid request origin."},403);
  let context:Awaited<ReturnType<typeof requireAdmin>>;
  try{context=await requireAdmin(req);}catch(error){return adminAuthErrorResponse(error,"reconcile_full_refund_review");}
  if(!fullRefundReviewReconciliationReady())return json({error:"Original refund reconciliation is not enabled."},404);
  let body:unknown;try{body=await req.json();}catch{return json({error:"Invalid review request."},400);}
  const input=parseRefundReviewReconciliation(body);if(!input)return json({error:"Confirm the exact original event and review revision."},400);
  try{const result=await reconcileFullRefundReview(context.admin,input);return json(result,result.status==="reconciliation_required"?409:200);}
  catch{return json({error:"The original refund still requires review. Refresh its saved state. Missing provenance, changed evidence or an uncertain outcome cannot release its hold."},409);}
}
