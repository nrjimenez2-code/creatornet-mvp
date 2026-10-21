import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { AdminAuthError } from "@/lib/admin/server";
import { dependenciesMet, validDiscordInvite, validFlags } from "./policy";
import { requireReleaseOwner, updateReleaseSettings } from "./server";
export async function readReleaseState({ settings, db }: Awaited<ReturnType<typeof requireReleaseOwner>>) {
  const [approved, audit] = await Promise.all([
    db.from("website_release_testers_v1").select("user_id,approved_at").order("approved_at", { ascending: false }).limit(500),
    db.from("admin_actions").select("id,action,target_id,reason,created_at").in("action", ["website_release_update", "website_tester_approve", "website_tester_revoke"]).order("created_at", { ascending: false }).limit(50),
  ]);
  if (approved.error || audit.error) throw new Error("Release read unavailable");
  return { settings, testers: approved.data ?? [], audit: audit.data ?? [] };
}
const headers = { "Cache-Control": "private, no-store" };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
export async function releaseManagement(req: NextRequest, testers = false) {
  try {
    const { user, settings, db } = await requireReleaseOwner(req);
    if (req.method === "GET") {
      return reply(await readReleaseState({ user, settings, db }));
    }
    if (req.headers.get("origin") !== req.nextUrl.origin) return reply({ error: "Use Release Controls on this website." }, 403);
    const text = await req.text();
    if (text.length > 16384) return reply({ error: "Request too large." }, 413);
    let input;
    try { input = JSON.parse(text); } catch { return reply({ error: "Invalid request." }, 400); }
    if (!input || !Number.isSafeInteger(input.revision) || input.revision !== settings.revision) return reply({ error: "Settings changed. Reload before saving." }, 409);
    if (testers) {
      if (typeof input.userId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.userId) || typeof input.approved !== "boolean") return reply({ error: "Enter an existing verified account ID." }, 400);
      const { error } = await db.rpc("set_website_tester_v1", { p_actor: user.id, p_revision: input.revision, p_user: input.userId, p_approved: input.approved });
      if (error) return reply({ error: "Tester update failed. Check the account ID and reload before trying again." }, 409);
    } else {
      if (typeof input.hidden !== "boolean" || !validFlags(input.features) || !dependenciesMet(input.features) || !validDiscordInvite(input.discordInvite)) return reply({ error: "Check the Discord invite and feature dependencies." }, 400);
      await updateReleaseSettings(user.id, input.revision, input.hidden, input.features, input.discordInvite);
    }
    return reply({ ok: true });
  } catch (error) {
    if (error instanceof AdminAuthError) return reply({ error: error.message }, error.status);
    return reply({ error: "Release Controls could not complete the request. Reload to check the current state before trying again." }, 503);
  }
}
