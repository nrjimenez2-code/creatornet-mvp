import { NextRequest } from "next/server";
import { reconcileUpload } from "@/lib/uploadTrackingHttp";
type Context = { params: Promise<{ attemptId: string }> };
export async function POST(req: NextRequest, context: Context) {
  return reconcileUpload(req, (await context.params).attemptId);
}
export async function GET(req: NextRequest, context: Context) {
  return reconcileUpload(req, (await context.params).attemptId, true);
}
