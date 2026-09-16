import "server-only";
import { cache } from "react";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { SELL_READY_COLUMNS } from "@/lib/sellReady";

// Shared only within one server render (including generateMetadata). This is
// public creator data, never viewer state or a persistent cross-request cache.
// Keep the original exact ID-first/username-fallback resolution and errors.
export const readCreatorPublicProfile = cache(async (creatorId: string) => {
  const fields = `id, username, full_name, tagline, avatar_url, bio, interests, ${SELL_READY_COLUMNS}`;
  const byId = await supabaseAdmin
    .from("profiles")
    .select(fields)
    .eq("id", creatorId)
    .maybeSingle();
  if (byId.data) return byId;
  const byUsername = await supabaseAdmin
    .from("profiles")
    .select(fields)
    .eq("username", creatorId)
    .maybeSingle();
  return byUsername.data ? byUsername : byId;
});
