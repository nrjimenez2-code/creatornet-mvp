import "server-only";

/** Prospective building block only: no current payment route imports this file.
 * This checks consistency, not authority to issue, collect, refund or deploy.
 * Existing Sandbox guards, durable agreements and migrations remain unchanged.
 */
export type ExactPaymentContext = Readonly<{
  version: "exact-payment-context-v1";
  mode: "test" | "live";
  platformAccountId: string;
  supabaseProjectRef: string;
  siteOrigin: string;
}>;

/** A future server adapter must obtain these facts independently. In particular,
 * a key's mode does not prove account ownership; configured URLs do not prove
 * database identity. Never construct this evidence from request/event metadata.
 * No credentials, process.env reads or provider calls belong in this module.
 */
export type ExactPaymentContextEvidence = Readonly<{
  approvedContext: ExactPaymentContext;
  vercelEnvironment: "preview" | "production";
  stripeSecretKeyMode: "test" | "live";
  stripePublishableKeyMode: "test" | "live";
  observedPlatformAccountId: string;
  observedSupabaseProjectRef: string;
  configuredSupabaseUrl: string;
  configuredSiteOrigin: string;
}>;

const fields = ["version", "mode", "platformAccountId", "supabaseProjectRef", "siteOrigin"] as const;
const evidenceFields = ["approvedContext", "vercelEnvironment", "stripeSecretKeyMode", "stripePublishableKeyMode",
  "observedPlatformAccountId", "observedSupabaseProjectRef", "configuredSupabaseUrl", "configuredSiteOrigin"] as const;
const validated = new WeakSet<object>();
const failure = () => new Error("Exact payment context validation failed");

// Persisted JSON/configuration must contain exactly these data fields. Reject
// accessors before reading values; no caller-provided input is echoed on failure.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(name => typeof name !== "string" || !keys.includes(name))) throw failure();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw failure();
    result[key] = descriptor.value;
  }
  return result;
}

function canonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password &&
      !url.port && url.hostname.length <= 253 && url.hostname.includes(".") &&
      url.hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
      !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(":");
  } catch { return false; }
}

function parseContext(value: unknown): ExactPaymentContext {
  const r = record(value, fields);
  if (r.version !== "exact-payment-context-v1" || (r.mode !== "test" && r.mode !== "live") ||
      typeof r.platformAccountId !== "string" || !/^acct_[A-Za-z0-9]{1,100}$/.test(r.platformAccountId) ||
      typeof r.supabaseProjectRef !== "string" || !/^[a-z0-9]{20}$/.test(r.supabaseProjectRef) ||
      !canonicalHttpsOrigin(r.siteOrigin)) throw failure();
  return Object.freeze({ version: r.version, mode: r.mode, platformAccountId: r.platformAccountId,
    supabaseProjectRef: r.supabaseProjectRef, siteOrigin: r.siteOrigin });
}

/** Validate a saved/prospective context against independently supplied server
 * evidence and explicit release-approved pins. No missing field defaults to live.
 * Success does not verify the provenance of evidence or authorize any payment.
 */
export function validateExactPaymentContext(context: unknown, evidence: unknown): ExactPaymentContext {
  try {
    const saved = parseContext(context);
    const e = record(evidence, evidenceFields);
    const approved = parseContext(e.approvedContext);
    if (fields.some(key => saved[key] !== approved[key]) ||
        e.vercelEnvironment !== (saved.mode === "live" ? "production" : "preview") ||
        e.stripeSecretKeyMode !== saved.mode || e.stripePublishableKeyMode !== saved.mode ||
        e.observedPlatformAccountId !== saved.platformAccountId ||
        e.observedSupabaseProjectRef !== saved.supabaseProjectRef ||
        e.configuredSupabaseUrl !== `https://${saved.supabaseProjectRef}.supabase.co` ||
        e.configuredSiteOrigin !== saved.siteOrigin) throw failure();
    // A hostname is never sufficient proof of mode; the pins and observations
    // above are required too. Preserve current Preview/production separation.
    const hostname = new URL(saved.siteOrigin).hostname;
    const previewHost = /^[a-z0-9-]+\.vercel\.app$/.test(hostname);
    const vercelNamespace = hostname === "vercel.app" || hostname.endsWith(".vercel.app");
    if ((saved.mode === "test" && !previewHost) || (saved.mode === "live" && vercelNamespace)) throw failure();
    validated.add(saved);
    return saved;
  } catch {
    // Includes malformed/accessor/proxy exceptions: never leak their messages.
    throw failure();
  }
}

/** Only a context validated in this process can check a freshly retrieved Stripe
 * object's mode. This does not replace signature, identity, money or ACL checks.
 */
export function assertStripeObjectMatchesExactContext(context: ExactPaymentContext, object: unknown): void {
  try {
    if (!validated.has(context) || !object || typeof object !== "object" || Array.isArray(object)) throw failure();
    const descriptor = Object.getOwnPropertyDescriptor(object, "livemode");
    if (!descriptor || !("value" in descriptor) || descriptor.value !== (context.mode === "live")) throw failure();
  } catch { throw failure(); }
}
