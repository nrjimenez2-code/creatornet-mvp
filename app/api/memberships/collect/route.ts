import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { membershipWorkerReady, runMembershipBillingWorker } from "@/lib/membershipWorker";
import { monitorMembershipCron } from "@/lib/membershipCronMonitor";
import { buyerMentorshipWorkerReady, runBuyerMentorshipBillingWorker } from "@/lib/mentorshipInstallmentWorker";
import { fullRefundReviewReady, readFullRefundReviewBacklog } from "@/lib/fullRefundReviewBacklog";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET(req: NextRequest) {
  const membershipsEnabled=membershipWorkerReady(),installmentsEnabled=buyerMentorshipWorkerReady(),refundReviewEnabled=fullRefundReviewReady();
  if (!membershipsEnabled && !installmentsEnabled && !refundReviewEnabled) return Response.json({ error: "Monthly worker is not enabled." }, { status: 409, headers });
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return Response.json({ error: "Monthly worker authentication is not configured." }, { status: 503, headers });
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(req.headers.get("authorization") || ""), hash("Bearer " + secret)))
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  if (new URL(req.url).searchParams.size !== 0) return Response.json({ error: "Worker selection is server-owned." }, { status: 400, headers });
  return monitorMembershipCron("collect", async () => { try {
    const settled=await Promise.allSettled([
      membershipsEnabled?runMembershipBillingWorker():Promise.resolve(null),
      installmentsEnabled?runBuyerMentorshipBillingWorker():Promise.resolve(null),
      refundReviewEnabled?readFullRefundReviewBacklog():Promise.resolve(null),
    ]);
    if(settled.some(result=>result.status==="rejected"))throw Error("Billing batch requires review");
    const results=settled.map(result=>result.status==="fulfilled"?result.value:null);
    const failed=results.reduce((sum,result)=>sum+(result && "failed" in result?result.failed:0),0);
    const needsReview=results.reduce((sum,result)=>sum+(result && "needsReview" in result?result.needsReview:0),0);
    return Response.json({memberships:results[0],installments:results[1],refundReview:results[2],failed,needsReview},{status:failed||needsReview?503:200,headers});
  } catch { return Response.json({ error: "Monthly worker needs retry or review." }, { status: 503, headers }); } });
}
