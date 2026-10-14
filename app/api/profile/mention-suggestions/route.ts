import { NextResponse } from "next/server";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { suggestMentionAccounts } from "@/lib/profileMentionsServer";
import { USERNAME_PATTERN } from "@/lib/profileBio";

export async function GET(req: Request) {
  if (!allowRequest(`profile-mentions:${clientKey(req)}`, { limit: 90, windowMs: 60_000 })) return tooManyRequests();
  const query = new URL(req.url).searchParams.get("q") ?? "";
  if (!USERNAME_PATTERN.test(query)) return NextResponse.json({ error: "Invalid username query." }, { status: 400 });
  try {
    return NextResponse.json({ accounts: await suggestMentionAccounts(query) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Suggestions unavailable." }, { status: 503 });
  }
}
