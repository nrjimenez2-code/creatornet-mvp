/** Nonsecret display data only. Never pass a server credential to the UI. */
export type AdminPaymentMode = "test" | "live" | "unknown";

export function paymentModeFromKey(key: string | undefined): AdminPaymentMode {
  if (key?.startsWith("sk_test_") || key?.startsWith("rk_test_")) return "test";
  if (key?.startsWith("sk_live_") || key?.startsWith("rk_live_")) return "live";
  return "unknown";
}

export function operatorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "A";
}
