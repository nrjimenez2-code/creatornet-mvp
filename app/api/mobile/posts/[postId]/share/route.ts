import { POST as websiteShare } from "@/app/api/posts/[postId]/share/route";
import { mobileApi } from "@/lib/mobileApi";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ postId: string }> };
const handler = (req: NextRequest, context: Context) =>
  mobileApi(inner => websiteShare(inner, context), ["POST"], false)(req);
export const POST = handler;
export const OPTIONS = handler;
