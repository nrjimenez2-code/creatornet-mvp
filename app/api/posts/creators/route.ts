import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type Payload = {
  postIds?: string[];
};

export async function POST(req: Request) {
  let body: Payload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  const postIds = Array.isArray(body.postIds)
    ? body.postIds.filter((id): id is string => Boolean(id && typeof id === "string"))
    : [];

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
        { error: error.message },
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
      { error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}



