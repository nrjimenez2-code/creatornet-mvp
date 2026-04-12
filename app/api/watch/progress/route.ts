// app/api/watch/progress/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabaseClient";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

async function requireUser(req: NextRequest): Promise<{ userId: string } | null> {
  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    if (data?.user?.id) return { userId: data.user.id };
  } catch {
    // fall through
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const post_id = url.searchParams.get("post_id");
    if (!post_id) {
      return NextResponse.json({ error: "post_id is required" }, { status: 400 });
    }

    const session = await requireUser(req);
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const { data, error } = await admin
      .from("watch_progress")
      .select("seconds, duration, completed, updated_at")
      .eq("user_id", session.userId)
      .eq("post_id", post_id)
      .maybeSingle();

    if (error) {
      console.error("GET progress error:", error);
      return NextResponse.json({ error: "Failed to load progress" }, { status: 500 });
    }

    return NextResponse.json({ progress: data ?? null });
  } catch (err) {
    console.error("GET progress unexpected:", err);
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { post_id, seconds, duration, completed } = await req.json();

    if (!post_id || typeof seconds !== "number" || typeof duration !== "number") {
      return NextResponse.json(
        { error: "post_id, seconds, and duration are required" },
        { status: 400 }
      );
    }

    const session = await requireUser(req);
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const clampedSeconds = Math.max(0, Math.min(seconds, duration));
    const isCompleted =
      typeof completed === "boolean"
        ? completed
        : duration > 0 && clampedSeconds / duration >= 0.95;

    const { error } = await admin
      .from("watch_progress")
      .upsert(
        {
          user_id: session.userId,
          post_id,
          seconds: clampedSeconds,
          duration,
          completed: isCompleted,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,post_id" }
      );

    if (error) {
      console.error("POST progress error:", error);
      return NextResponse.json({ error: "Failed to save progress" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST progress unexpected:", err);
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
  }
}
