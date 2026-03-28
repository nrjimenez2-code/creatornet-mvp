import { supabaseAdmin } from "@/lib/supabaseAdmin";

/** Creator finished Stripe Connect Express onboarding; safe for destination charges. */
export async function isCreatorSellReady(creatorId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("stripe_account_id, stripe_onboarding_complete")
    .eq("id", creatorId)
    .maybeSingle();
  return !!(data?.stripe_account_id && data.stripe_onboarding_complete);
}
