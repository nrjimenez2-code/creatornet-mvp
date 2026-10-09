import { PATCH as websitePatch, DELETE as websiteDelete } from "@/app/api/posts/[postId]/comments/[commentId]/route";
import { mobileApi } from "@/lib/mobileApi";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ postId: string; commentId: string }> };
export const PATCH = (req: NextRequest, context: Context) =>
  mobileApi(inner => websitePatch(inner, context), ["PATCH"])(req);
export const DELETE = (req: NextRequest, context: Context) =>
  mobileApi(inner => websiteDelete(inner, context), ["DELETE"])(req);
export const OPTIONS = mobileApi(async () => new Response(null, { status: 204 }), ["PATCH", "DELETE"]);
