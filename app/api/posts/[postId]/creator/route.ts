import { NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { createClient } from "@supabase/supabase-js";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Near-dead code in production (only reachable when a card has neither a
// creator id nor a username), so this ceiling is unreachable by real users.
const CREATOR_RATE = { limit: 120, windowMs: 60_000 };

export async function GET(
  req: Request,
  { params }: { params: Promise<{ postId: string }> }
) {
  if (!allowRequest(`post-creator:${clientKey(req)}`, CREATOR_RATE)) return tooManyRequests();
  const { postId } = await params;

  if (!postId) {
    return NextResponse.json(
      { error: "Missing postId" },
      { status: 400 }
    );
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data, error } = await admin
      .from("posts")
      .select("creator_id")
      .eq("id", postId)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: publicMessage("post-creator", error, "Could not load creator.") },
        { status: 500 }
      );
    }

    if (!data?.creator_id) {
      return NextResponse.json(
        { error: "Creator not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ creatorId: data.creator_id });
  } catch (err: any) {
    return NextResponse.json(
      { error: publicMessage("post-creator", err, "Unknown error") },
      { status: 500 }
    );
  }
}



