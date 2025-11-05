// app/api/watch/progress/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabaseClient"; // same helper you used elsewhere

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const post_id = url.searchParams.get("post_id");
    if (!post_id) {
      return NextResponse.json({ error: "post_id is required" }, { status: 400 });
    }

    const supabase = createClient();
    const { data: auth } = await supabase.auth.getUser();
    const user = auth?.user;
    if (!user) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("watch_progress")
      .select("seconds, duration, completed, updated_at")
      .eq("user_id", user.id)
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

export async function POST(req: Request) {
  try {
    const { post_id, seconds, duration, completed } = await req.json();

    if (!post_id || typeof seconds !== "number" || typeof duration !== "number") {
      return NextResponse.json(
        { error: "post_id, seconds, and duration are required" },
        { status: 400 }
      );
    }

    const supabase = createClient();
    const { data: auth } = await supabase.auth.getUser();
    const user = auth?.user;
    if (!user) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const clampedSeconds = Math.max(0, Math.min(seconds, duration));
    const isCompleted =
      typeof completed === "boolean"
        ? completed
        : duration > 0 && clampedSeconds / duration >= 0.95;

    const { error } = await supabase
      .from("watch_progress")
      .upsert(
        {
          user_id: user.id,
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
