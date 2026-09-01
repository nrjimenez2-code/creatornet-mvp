import { NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { createClient } from "@supabase/supabase-js";
import { isSafeId } from "@/lib/ids";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// This route is unauthenticated and runs on the service-role client, so the
// request body is the only thing bounding its work. 200 is far more than the
// feed ever asks for in one page.
const MAX_POST_IDS = 200;

// Generous: the feed calls this legitimately on most page loads.
const CREATORS_RATE = { limit: 60, windowMs: 60_000 };

type Payload = {
  postIds?: string[];
};

export async function POST(req: Request) {
  if (!allowRequest(clientKey(req), CREATORS_RATE)) {
    return tooManyRequests();
  }

  let body: Payload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  // Cap and validate. Without the cap an anonymous caller could post 100k ids
  // and make the service-role client build one enormous IN (...) query; without
  // the id check, junk strings reach a uuid column and the whole batch errors.
  const postIds = (Array.isArray(body.postIds) ? body.postIds : [])
    .filter((id): id is string => isSafeId(id))
    .slice(0, MAX_POST_IDS);

  if (!postIds.length) {
    return NextResponse.json(
      { creators: {} },
      { status: 200 }
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
      .select("id, creator_id")
      .in("id", postIds);

    if (error) {
      return NextResponse.json(
        { error: publicMessage("post-creators", error, "Could not load creators.") },
        { status: 500 }
      );
    }

    const creators: Record<string, string> = {};
    for (const row of data || []) {
      if (row?.id && row?.creator_id) {
        creators[row.id] = row.creator_id;
      }
    }

    return NextResponse.json({ creators });
  } catch (err: any) {
    return NextResponse.json(
      { error: publicMessage("post-creators", err, "Unknown error") },
      { status: 500 }
    );
  }
}



