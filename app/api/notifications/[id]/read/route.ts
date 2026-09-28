import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isSameOriginRequest } from "@/lib/sameOrigin";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("recipient_id", user.id)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Notification could not be updated." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Notification not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
