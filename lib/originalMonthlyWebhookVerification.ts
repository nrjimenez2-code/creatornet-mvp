/** Optional signed-delivery observation for the closed original TEST Preview.
 * This mode acknowledges verified notifications without sharing financial
 * event claims. Omitting the flag retains ordinary webhook processing. */
export function originalMonthlyWebhookMode(env: Record<string, string | undefined> = process.env): "process" | "verify-only" | "invalid" {
  const selected = env.CREATOR_ORIGINAL_MONTHLY_WEBHOOK_VERIFY_ONLY;
  if (selected === undefined) return "process";
  if (selected !== "true" || env.CREATOR_ORIGINAL_MONTHLY_COMPLETION_PROFILE !== "original-monthly-completion-v1" ||
      env.VERCEL_ENV !== "preview" || env.VERCEL_TARGET_ENV !== "preview" ||
      env.VERCEL_PROJECT_ID !== "prj_lfRTdoQU0BrsSnJajvLTcSCvjrAA" ||
      env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED !== "true" ||
      env.CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED !== "false" ||
      env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT !== "false" ||
      env.NEXT_PUBLIC_SUPABASE_URL !== "https://nwqfofezfzljhxolkycz.supabase.co" ||
      !/^creatornet-[a-z0-9]+-nrjimenez2-codes-projects\.vercel\.app$/.test(env.VERCEL_URL || "") ||
      !/^dpl_[A-Za-z0-9]+$/.test(env.VERCEL_DEPLOYMENT_ID || "")) return "invalid";
  return "verify-only";
}
