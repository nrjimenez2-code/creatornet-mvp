// lib/apiError.ts — what an error response may say to the browser.
//
// Routes used to return error.message straight from Supabase or Stripe.
// Those messages name tables, columns, constraints and ids
// ("invalid input syntax for type uuid", "column profiles.email does not
// exist", "violates foreign key constraint ..."), which is free schema
// reconnaissance for anyone poking at the API. The pages only display the
// `error` string, so it has to stay a readable sentence; it just should not
// be the database's sentence.
//
// publicMessage keeps messages the application wrote itself (plain Error
// with no database/Stripe fingerprint) and replaces everything else with
// the fallback. The real error is always logged server-side first.

type ErrLike =
  | { message?: unknown; code?: unknown; hint?: unknown; details?: unknown; type?: unknown }
  | null
  | undefined;

const INTERNAL_PATTERNS = [
  /\bcolumn\b/i,
  /\brelation\b/i,
  /\bconstraint\b/i,
  /\bviolates\b/i,
  /\bsyntax\b/i,
  /\btype uuid\b/i,
  /\bPGRST\d*/,
  /\bschema cache\b/i,
  /\bpermission denied\b/i,
  /\brow-level security\b/i,
  /\bduplicate key\b/i,
  /\bstripe\b/i,
  /\bapi key\b/i,
  /\bfetch failed\b/i,
  /ECONN|ETIMEDOUT|ENOTFOUND/,
];

function looksInternal(err: ErrLike): boolean {
  if (!err || typeof err !== "object") return true;
  const code = err.code;
  if (typeof code === "string" && (/^\d{5}$/.test(code) || code.startsWith("PGRST"))) return true;
  if (err.hint != null || err.details != null) return true;
  if (typeof err.type === "string" && /^Stripe/.test(err.type)) return true;
  const msg = typeof err.message === "string" ? err.message : "";
  if (!msg) return true;
  return INTERNAL_PATTERNS.some((re) => re.test(msg));
}

/**
 * Log `err` under `tag` and return a message safe to send to the browser.
 * Application-written messages pass through; database, Stripe and network
 * errors become `fallback`.
 */
export function publicMessage(tag: string, err: unknown, fallback: string): string {
  const e = err as ErrLike;
  const raw =
    e && typeof e === "object" && typeof e.message === "string" ? e.message : String(err);
  console.error(`[${tag}]`, raw, e && typeof e === "object" && "code" in e ? { code: e.code } : "");
  if (looksInternal(e)) return fallback;
  return raw.length > 200 ? fallback : raw;
}
