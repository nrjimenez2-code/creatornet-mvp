const AUTH_PATH = "/auth";

/**
 * Build the single post-authentication destination used by passwordless email
 * and social OAuth. Keeping this pure makes the production www host and the
 * browser fallback independently testable.
 */
export function buildAuthRedirectUrl(
  configuredSiteUrl: string | undefined,
  currentOrigin: string,
): string {
  const baseUrl = configuredSiteUrl?.trim() || currentOrigin.trim();
  const parsed = new URL(baseUrl);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The authentication site URL must use HTTP or HTTPS.");
  }

  return new URL(AUTH_PATH, `${parsed.origin}/`).toString();
}
