// app/api/watch/progress/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/Bearer\s+(.+)/i);
  return match ? match[1].trim() : null;
}

function normalizeBase64(input: string): string {
  const replaced = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = replaced.length % 4;
  if (padding === 0) return replaced;
  return replaced.padEnd(replaced.length + (4 - padding), "=");
}

function extractAccessToken(cookieStore: CookieStore): string | null {
  try {
    const projectRef = new URL(SUPABASE_URL).host.split(".")[0];
    const cookieName = `sb-${projectRef}-auth-token`;
    const cookie = cookieStore.get(cookieName);
    if (!cookie?.value) return null;

    let raw = cookie.value;
    if (raw.startsWith("base64-")) raw = raw.slice("base64-".length);

    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        const normalized = normalizeBase64(raw);
        const decoded = Buffer.from(normalized, "base64").toString("utf8");
        parsed = JSON.parse(decoded);
      } catch {
        parsed = null;
      }
    }

    if (!parsed) return null;
    if (Array.isArray(parsed)) {
      const [access_token] = parsed;
      return typeof access_token === "string" ? access_token : null;
    }
    if (typeof parsed === "object") {
      return typeof parsed?.access_token === "string" ? parsed.access_token : null;
    }
    return null;
  } catch {
    return null;
  }
}

function decodeUserId(token: string): string | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const normalized = normalizeBase64(payload);
    const json = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed?.sub === "string" ? parsed.sub : null;
  } catch {
    return null;
  }
}

async function requireUser(req: NextRequest) {
  const bearerToken = extractBearerToken(req.headers.get("authorization"));
  const cookieStore = await cookies();
  const token = bearerToken || extractAccessToken(cookieStore);
  if (!token) return null;
  const userId = decodeUserId(token);
  if (!userId) return null;
  return { token, userId };
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
