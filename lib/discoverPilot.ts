import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DiscoverPilotVariant = "control" | "commercial";

export function pilotVariant(experimentId: string, userId: string): DiscoverPilotVariant {
  const bucket = createHash("sha256").update(`discover-pilot-v1:${experimentId}:${userId}`).digest().readUInt32BE(0);
  return bucket % 2 === 0 ? "control" : "commercial";
}

// Only signed-in Discover viewers enroll. Assignment persists independently of the
// two-hour feed snapshot so delayed purchases can be measured after it expires.
export async function assignDiscoverPilot(
  admin: SupabaseClient,
  userId: string | null,
  tab: string,
  experimentId = process.env.DISCOVER_PILOT_ID,
  now = Date.now(),
): Promise<{ experimentId: string; variant: DiscoverPilotVariant } | null> {
  if (!experimentId || !userId || tab !== "discover") return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(experimentId)) throw new Error("Invalid Discover pilot ID");
  const { data: experiment, error } = await admin.from("discover_pilots_v1")
    .select("id,starts_at,ends_at,enabled,policy_version,eligible_user_ids").eq("id", experimentId).single();
  if (error || !experiment || experiment.policy_version !== "commercial-order-v1")
    throw new Error("Discover pilot configuration unavailable");
  if (!experiment.enabled || now < Date.parse(experiment.starts_at) || now >= Date.parse(experiment.ends_at)) return null;
  if (!Array.isArray(experiment.eligible_user_ids) || !experiment.eligible_user_ids.includes(userId)) return null;
  const assignment = { experiment_id: experimentId, user_id: userId, variant: pilotVariant(experimentId, userId) };
  const saved = await admin.from("discover_pilot_assignments_v1")
    .upsert(assignment, { onConflict: "experiment_id,user_id", ignoreDuplicates: true });
  if (saved.error) throw saved.error;
  const { data, error: readError } = await admin.from("discover_pilot_assignments_v1")
    .select("variant").eq("experiment_id", experimentId).eq("user_id", userId).single();
  if (readError || !data || !["control", "commercial"].includes(data.variant))
    throw new Error("Discover pilot assignment unavailable");
  return { experimentId, variant: data.variant as DiscoverPilotVariant };
}
