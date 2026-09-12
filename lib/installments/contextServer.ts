import "server-only";
import { CONTEXT_CUSTOMER_API_VERSION } from "./contextBootstrap";
import { createExactContextRuntime, type ExactContextRuntimeConfig } from "./contextRuntime";

/** #3 server composition only. A disabled/invalid context never becomes an
 * instruction to process a v2 payment with the legacy SDK. No defaults guess
 * the live account, project or site. #8 owns approval of the actual values. */
export function exactContextServerConfig(env: Record<string, string | undefined> = process.env): ExactContextRuntimeConfig {
  if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY !== "true") throw Error("Context payment routes are not enabled");
  try {
    const key = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
    const mode = /^pk_(test|live)_[A-Za-z0-9]+$/.exec(key)?.[1];
    if (mode !== "test" && mode !== "live") throw Error("Invalid mode");
    if (env.VERCEL_ENV !== "preview" && env.VERCEL_ENV !== "production") throw Error("Invalid deployment");
    const config: ExactContextRuntimeConfig = {
      approvedContext: JSON.parse(env.CREATOR_EXACT_INSTALLMENTS_CONTEXT ?? ""), vercelEnvironment: env.VERCEL_ENV,
      configuredSupabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? "", configuredSiteOrigin: env.NEXT_PUBLIC_SITE_URL ?? "",
      stripeSecretKey: env.STRIPE_SECRET_KEY ?? "", stripePublishableKeyMode: mode,
      supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "", expectedApiVersion: CONTEXT_CUSTOMER_API_VERSION,
    };
    createExactContextRuntime(config); // Static consistency; no network or mutation.
    return Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  } catch { throw Error("Context server configuration requires review"); }
}
