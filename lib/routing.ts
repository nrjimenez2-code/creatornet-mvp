// lib/routing.ts
import type { SupabaseClient } from "@supabase/supabase-js";

/** Routing modes supported by CreatorNet */
export type RoutingMode = "single" | "round_robin" | "weighted" | "sticky";

/** Row shape for the team_routing table */
type TeamRoutingRow = {
  creator_id: string;
  mode: RoutingMode | null;
  default_closer_id: string | null;
};

/** Closer record used by routing */
export type Closer = {
  id: string;
  name: string | null;
  booking_url: string;
  weight: number | null;
};

/** Row shape for lightweight recent click sampling */
type BookingClickRow = {
  closer_id: string | null;
  ts: string; // timestamp
};

/**
 * Returns the Closer record this viewer should be routed to,
 * honoring the creator's routing mode & set of active closers.
 */
export async function getBookingTarget(
  creatorId: string,
  viewerId: string | null,
  supabaseAdmin: SupabaseClient
): Promise<Closer | null> {
  // Fetch routing settings + active closers in parallel
  const [{ data: routingRow }, { data: closersData }] = await Promise.all([
    supabaseAdmin
      .from("team_routing")
      .select("creator_id,mode,default_closer_id")
      .eq("creator_id", creatorId)
      .maybeSingle<TeamRoutingRow>(),
    supabaseAdmin
      .from("closers")
      .select("id,name,booking_url,weight")
      .eq("creator_id", creatorId)
      .eq("active", true)
      .returns<Closer[]>(),
  ]);

  const routing: TeamRoutingRow | null = routingRow ?? null;
  const closers: Closer[] = Array.isArray(closersData) ? closersData : [];

  if (!closers.length) return null;

  const mode: RoutingMode = (routing?.mode ?? "single") as RoutingMode;

  // --- SINGLE: pick the default closer or the first active one ---
  if (mode === "single") {
    const picked =
      (routing?.default_closer_id &&
        closers.find((c) => c.id === routing.default_closer_id)) ||
      closers[0];
    return picked || null;
  }

  // --- STICKY: hash viewerId consistently to a closer ---
  if (mode === "sticky" && viewerId) {
    const idx = stableHash(viewerId) % closers.length;
    return closers[idx] || null;
  }

  // --- WEIGHTED: expand list by weight; otherwise round-robin on raw list ---
  const pool = mode === "weighted" ? expandByWeight(closers) : closers.slice();

  // Sample recent clicks to approximate round-robin
  const { data: recent } = await supabaseAdmin
    .from("booking_clicks")
    .select("closer_id, ts")
    .eq("creator_id", creatorId)
    .order("ts", { ascending: false })
    .limit(200)
    .returns<BookingClickRow[]>();

  const counts = new Map<string, number>();
  pool.forEach((c) => counts.set(c.id, 0));

  for (const r of recent || []) {
    if (!r.closer_id) continue;
    counts.set(r.closer_id, (counts.get(r.closer_id) || 0) + 1);
  }

  // Pick the closer with the lowest recent count
  let best: Closer = pool[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const c of pool) {
    const n = counts.get(c.id) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best || null;
}

/** Expand a closer list by weight (min 1, max 100) for weighted routing */
function expandByWeight(list: Closer[]): Closer[] {
  const out: Closer[] = [];
  for (const c of list) {
    const w = clampInt(c.weight ?? 1, 1, 100);
    for (let i = 0; i < w; i++) out.push(c);
  }
  return out;
}

function clampInt(n: number, min: number, max: number) {
  const x = Math.round(Number.isFinite(n) ? n : min);
  return Math.max(min, Math.min(max, x));
}

/** Fast, deterministic string hash (FNV-1a-ish) */
function stableHash(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
