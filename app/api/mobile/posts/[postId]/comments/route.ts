import { GET as websiteGet, POST as websitePost } from "@/app/api/posts/[postId]/comments/route";
import { mobileApi } from "@/lib/mobileApi";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ postId: string }> };
export const GET = (req: NextRequest, context: Context) =>
  mobileApi(inner => websiteGet(inner, context), ["GET"], false)(req);
export const POST = (req: NextRequest, context: Context) =>
  mobileApi(inner => websitePost(inner, context), ["POST"])(req);
export const OPTIONS = mobileApi(async () => new Response(null, { status: 204 }), ["GET", "POST"], false);
