// lib/authError.ts — turning a failed OAuth round-trip into something the user
// can actually read.
//
// Supabase sends a failed sign-in back to the redirect URL with the reason in
// the URL: either as a query string (`?error=...&error_description=...`) or, for
// the implicit flow, in the hash fragment (`#error=...`). Nothing in this app
// read either, so a failed sign-in landed the user on a normal-looking sign-in
// page with no message at all — indistinguishable from "I clicked it and
// nothing happened", which is exactly how the failure was reported to us.
//
// SECURITY: `error_description` is attacker-controllable. Anyone can send a
// victim to https://<site>/auth?error=x&error_description=Your+account+is+locked,
// +call+555-0100 and, if we echoed it, that text would render on a page the
// victim correctly believes is ours. React escapes HTML so this is not XSS, but
// it is a free phishing surface. So we NEVER render provider-supplied prose.
// We map a short, character-validated code onto our own fixed strings, and keep
// the raw description for logs only, where it cannot be read by a victim.

/** What we managed to pull out of the URL. `description` is for LOGS ONLY. */
export type AuthUrlError = {
  /** Normalised, character-validated. Safe to log and to switch on. */
  code: string | null;
  /** Raw provider text. NEVER render this. Diagnostics only. */
  description: string | null;
};

/** Codes we recognise. Anything else falls through to a generic message. */
const CANCELLED = new Set(["access_denied", "user_cancelled", "consent_required"]);
const PROVIDER_BROKEN = new Set([
  "server_error",
  "unexpected_failure",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "temporarily_unavailable",
]);

const MAX_CODE_LEN = 64;
const MAX_DESCRIPTION_LEN = 300;

/**
 * Reduce a URL-supplied token to something safe to log and compare.
 * Returns null for anything that is not a plausible OAuth error code.
 */
function normaliseCode(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_CODE_LEN);
}

function readParams(source: string): URLSearchParams | null {
  if (!source) return null;
  // Accept "?a=b", "#a=b" or "a=b" — callers pass location.search / location.hash
  // verbatim and those carry their leading punctuation.
  const trimmed = source.replace(/^[?#]/, "");
  if (!trimmed) return null;
  try {
    return new URLSearchParams(trimmed);
  } catch {
    return null;
  }
}

/**
 * Pull an OAuth error out of a URL's query string and/or hash fragment.
 *
 * Checks the query string first, then the hash — Supabase uses the hash for the
 * implicit flow and the query string elsewhere, and only one of them ever
 * carries an error.
 *
 * @param search `location.search` (may be empty)
 * @param hash   `location.hash` (may be empty)
 * @returns the error, or null when the URL describes no failure
 */
export function parseAuthErrorFromUrl(
  search: string | null | undefined,
  hash: string | null | undefined
): AuthUrlError | null {
  for (const source of [search ?? "", hash ?? ""]) {
    const params = readParams(source);
    if (!params) continue;

    // `error_code` is the more specific of the two when both are present.
    const code = normaliseCode(params.get("error_code")) ?? normaliseCode(params.get("error"));
    const rawDescription = params.get("error_description");

    // An `error_description` with no usable code still means the sign-in failed;
    // we must not stay silent just because the code was missing or malformed.
    if (!code && !rawDescription) continue;

    return {
      code,
      description: rawDescription ? rawDescription.slice(0, MAX_DESCRIPTION_LEN) : null,
    };
  }
  return null;
}

/**
 * Our own words for what went wrong. Deliberately never includes provider text.
 *
 * @see AuthUrlError — the reason this does not echo `description`.
 */
export function friendlyAuthError(error: AuthUrlError): string {
  const { code } = error;

  if (code && CANCELLED.has(code)) {
    return "Sign-in was cancelled. You can try again whenever you like.";
  }
  if (code && PROVIDER_BROKEN.has(code)) {
    return "That sign-in method isn't working right now. Please try Google, or sign in with your email instead.";
  }
  return "Sign-in didn't complete. Please try again, or use a different sign-in method.";
}

/**
 * Remove the error parameters from the visible URL.
 *
 * Without this the message would come back on every refresh, and the raw
 * failure would sit in the address bar for the user to copy into a bug report
 * or, worse, share. Returns the cleaned "path?query#hash" string; callers hand
 * it to history.replaceState.
 *
 * Only the error keys are dropped — anything else the URL carried is preserved.
 */
export function urlWithoutAuthError(
  pathname: string,
  search: string | null | undefined,
  hash: string | null | undefined
): string {
  const ERROR_KEYS = ["error", "error_code", "error_description", "error_uri"];

  const strip = (source: string | null | undefined): string => {
    const params = readParams(source ?? "");
    if (!params) return "";
    for (const key of ERROR_KEYS) params.delete(key);
    return params.toString();
  };

  const nextSearch = strip(search);
  const nextHash = strip(hash);
  return `${pathname}${nextSearch ? `?${nextSearch}` : ""}${nextHash ? `#${nextHash}` : ""}`;
}
