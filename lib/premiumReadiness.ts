/** Disabling new creation/checkout must never disable already purchased delivery. */
export const premiumSchemaReady = (env: Record<string, string | undefined> = process.env) => env.CREATOR_PREMIUM_DELIVERY_SCHEMA_READY === "true";
export const premiumPostingReady = (env: Record<string, string | undefined> = process.env) => premiumSchemaReady(env) && env.CREATOR_PREMIUM_DELIVERY_READY === "true";
