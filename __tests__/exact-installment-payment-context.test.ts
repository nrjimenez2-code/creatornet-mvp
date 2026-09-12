/** NEW context-validation assertions only. Synthetic values, no Stripe/DB calls,
 * no deployment, no real credentials, no existing payment tests repeated. */
import { assertStripeObjectMatchesExactContext, validateExactPaymentContext,
  type ExactPaymentContext, type ExactPaymentContextEvidence } from "../lib/installments/paymentContext";

function fixture(mode: "test" | "live" = "test") {
  const context: ExactPaymentContext = {
    version: "exact-payment-context-v1", mode, platformAccountId: "acct_syntheticPlatform",
    supabaseProjectRef: mode === "test" ? "aaaaaaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbbbbbb",
    siteOrigin: mode === "test" ? "https://synthetic-preview.vercel.app" : "https://synthetic-production.example",
  };
  const evidence: ExactPaymentContextEvidence = {
    approvedContext: { ...context }, vercelEnvironment: mode === "test" ? "preview" : "production",
    stripeSecretKeyMode: mode, stripePublishableKeyMode: mode, observedPlatformAccountId: context.platformAccountId,
    observedSupabaseProjectRef: context.supabaseProjectRef,
    configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: context.siteOrigin,
  };
  return { context, evidence };
}

test.each(["test", "live"] as const)("accepts a fully matching synthetic %s context without enabling anything", mode => {
  const { context, evidence } = fixture(mode);
  const result = validateExactPaymentContext(context, evidence);
  expect(result).toEqual(context);
  expect(result).not.toBe(context);
  expect(Object.isFrozen(result)).toBe(true);
  assertStripeObjectMatchesExactContext(result, { id: "synthetic", livemode: mode === "live" });
  Object.assign(context, { siteOrigin: "https://changed.example" }); // caller mutation cannot change the issued snapshot
  expect(result.siteOrigin).toBe(evidence.configuredSiteOrigin);
});

test.each(["approvedContext", "vercelEnvironment", "stripeSecretKeyMode", "stripePublishableKeyMode",
  "observedPlatformAccountId", "observedSupabaseProjectRef", "configuredSupabaseUrl", "configuredSiteOrigin"])(
  "missing %s evidence fails closed", key => {
    const { context, evidence } = fixture();
    const missing = { ...evidence } as Record<string, unknown>;
    delete missing[key];
    expect(() => validateExactPaymentContext(context, missing)).toThrow("Exact payment context validation failed");
  });

test.each([
  ["vercelEnvironment", "production"], ["vercelEnvironment", "development"],
  ["stripeSecretKeyMode", "live"], ["stripePublishableKeyMode", "live"],
  ["observedPlatformAccountId", "acct_other"], ["observedSupabaseProjectRef", "cccccccccccccccccccc"],
  ["configuredSupabaseUrl", "https://cccccccccccccccccccc.supabase.co"],
  ["configuredSupabaseUrl", "https://aaaaaaaaaaaaaaaaaaaa.supabase.co/"],
  ["configuredSiteOrigin", "https://other.vercel.app"],
])("mismatched %s cannot validate test context", (key, value) => {
  const { context, evidence } = fixture();
  expect(() => validateExactPaymentContext(context, { ...evidence, [key]: value })).toThrow();
});

test.each(["mode", "platformAccountId", "supabaseProjectRef", "siteOrigin"])("saved %s must match separate approved pins", key => {
  const { context, evidence } = fixture();
  const updates: Record<string, unknown> = { mode: "live", platformAccountId: "acct_other",
    supabaseProjectRef: "cccccccccccccccccccc", siteOrigin: "https://other.vercel.app" };
  const changed = { ...context, [key]: updates[key] };
  expect(() => validateExactPaymentContext(changed, evidence)).toThrow();
});

test.each([undefined, null, [], {}, "live", { mode: "live" }])("missing/ambiguous context never defaults to live: %p", value => {
  expect(() => validateExactPaymentContext(value, fixture("live").evidence)).toThrow();
});

test.each([
  "http://synthetic-preview.vercel.app", "https://synthetic-preview.vercel.app/",
  "https://synthetic-preview.vercel.app/path", "https://synthetic-preview.vercel.app?mode=live",
  "https://synthetic-preview.vercel.app#fragment", "https://user:private@synthetic-preview.vercel.app",
  "https://synthetic-preview.vercel.app:8443", "https://localhost", "https://127.0.0.1", "https://[::1]",
  "https://synthetic-preview.vercel.app.evil.example", "https://SYNTHETIC-preview.vercel.app",
])("rejects noncanonical or non-Preview test origin %s", siteOrigin => {
  const { context, evidence } = fixture();
  const changed = { ...context, siteOrigin };
  expect(() => validateExactPaymentContext(changed, { ...evidence, approvedContext: changed, configuredSiteOrigin: siteOrigin })).toThrow();
});

test.each(["https://synthetic-preview.vercel.app", "https://nested.synthetic-preview.vercel.app", "https://vercel.app"])(
  "%s cannot become live merely by changing all mode labels", siteOrigin => {
  const { context, evidence } = fixture("live");
  const changed = { ...context, siteOrigin };
  expect(() => validateExactPaymentContext(changed, { ...evidence, approvedContext: changed,
    configuredSiteOrigin: changed.siteOrigin })).toThrow();
});

test.each([
  ["version", "exact-payment-context-v2"], ["mode", true], ["platformAccountId", "cus_notAnAccount"],
  ["platformAccountId", "acct_"], ["supabaseProjectRef", "short"], ["supabaseProjectRef", "AAAAAAAAAAAAAAAAAAAA"],
])("rejects invalid context field %s even if configured pins repeat it", (key, value) => {
  const f = fixture(), changed = { ...f.context, [key]: value };
  expect(() => validateExactPaymentContext(changed, { ...f.evidence, approvedContext: changed })).toThrow();
});

test.each(["https://foo..example", "https://-foo.example", "https://foo-.example", `https://${"a".repeat(64)}.example`])(
  "rejects malformed production DNS hostname %s", siteOrigin => {
    const f = fixture("live"), changed = { ...f.context, siteOrigin };
    expect(() => validateExactPaymentContext(changed, { ...f.evidence, approvedContext: changed,
      configuredSiteOrigin: siteOrigin })).toThrow();
  });

test.each(["test", "live"] as const)("%s context rejects absent or opposite provider livemode", mode => {
  const f = fixture(mode), context = validateExactPaymentContext(f.context, f.evidence);
  for (const object of [null, [], {}, { livemode: null }, { livemode: "false" }, { livemode: mode !== "live" }]) {
    expect(() => assertStripeObjectMatchesExactContext(context, object)).toThrow();
  }
});

test("an unvalidated or copied context cannot check provider objects", () => {
  const f = fixture(), issued = validateExactPaymentContext(f.context, f.evidence);
  expect(() => assertStripeObjectMatchesExactContext(f.context, { livemode: false })).toThrow();
  expect(() => assertStripeObjectMatchesExactContext({ ...issued }, { livemode: false })).toThrow();
});

test("extra fields, inherited data and accessors are rejected without reading accessors", () => {
  const f = fixture();
  expect(() => validateExactPaymentContext({ ...f.context, override: true }, f.evidence)).toThrow();
  expect(() => validateExactPaymentContext(Object.create(f.context), f.evidence)).toThrow();
  const read = jest.fn(() => { throw new Error("synthetic private detail"); });
  const context = { ...f.context };
  Object.defineProperty(context, "mode", { enumerable: true, get: read });
  expect(() => validateExactPaymentContext(context, f.evidence)).toThrow("Exact payment context validation failed");
  expect(read).not.toHaveBeenCalled();
  const provider = Object.defineProperty({}, "livemode", { get: read });
  expect(() => assertStripeObjectMatchesExactContext(validateExactPaymentContext(f.context, f.evidence), provider)).toThrow();
  expect(read).not.toHaveBeenCalled();
});

test("input values and thrown proxy diagnostics are not exposed in errors", () => {
  const f = fixture();
  for (const context of [{ ...f.context, platformAccountId: "synthetic-private-marker" },
    new Proxy({}, { getPrototypeOf: () => { throw new Error("synthetic-private-marker"); } })]) {
    try { validateExactPaymentContext(context, f.evidence); throw new Error("expected rejection"); }
    catch (error) { expect((error as Error).message).toBe("Exact payment context validation failed"); }
  }
});
