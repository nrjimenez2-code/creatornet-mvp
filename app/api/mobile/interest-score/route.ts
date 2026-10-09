import type { NextRequest } from "next/server";
import { discoverEnabled } from "@/lib/discoverServer";
import { mobileApi } from "@/lib/mobileApi";
import { scoreInterestRequest } from "@/lib/interestScoreRequest";

export const dynamic = "force-dynamic";
const handler = mobileApi(async (request, user) => {
  if (discoverEnabled()) return Response.json({ ok: true, ignored: true });
  try {
    const body: unknown = await request.json();
    return Response.json(await scoreInterestRequest(user?.id ?? null, body));
  } catch {
    // An analytics write must not prevent navigation or playback.
    return Response.json({ ok: true });
  }
}, ["POST"], false);
export const POST = handler;
export const OPTIONS = handler;
