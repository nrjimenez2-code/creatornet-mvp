import { NextRequest } from "next/server";
import { mobileApi } from "@/lib/mobileApi";
import { submitPostReport } from "@/lib/postReportServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = mobileApi(async (req: NextRequest, user) => {
  try {
    return await submitPostReport(req, user!.id);
  } catch (error) {
    console.error("[post-reports] mobile submission failed", error);
    return Response.json({ error: "Could not save this report. Please try again." }, { status: 500 });
  }
}, ["POST"]);
export const POST = handler;
export const OPTIONS = handler;
