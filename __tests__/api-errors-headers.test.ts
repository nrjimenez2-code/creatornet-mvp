/**
 * Error-message sanitising and the response header set.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { publicMessage } from "@/lib/apiError";

const REPO_ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe("publicMessage", () => {
  const FB = "Something went wrong.";

  test("database errors are replaced, and logged", () => {
    const samples = [
      { message: 'column profiles.email does not exist', code: "42703" },
      { message: 'invalid input syntax for type uuid: "abc"', code: "22P02" },
      { message: 'insert or update on table "orders" violates foreign key constraint "orders_post_id_fkey"', code: "23503" },
      { message: "Could not find the function public.toggle_post_like in the schema cache", code: "PGRST202" },
      { message: "permission denied for table profiles", code: "42501" },
      { message: "new row violates row-level security policy", code: "42501" },
      { message: "duplicate key value violates unique constraint", code: "23505" },
      { message: "anything", hint: "Perhaps you meant ..." },
    ];
    for (const e of samples) expect(publicMessage("t", e, FB)).toBe(FB);
    expect(console.error).toHaveBeenCalledTimes(samples.length);
  });

  test("Stripe and network errors are replaced", () => {
    expect(publicMessage("t", { message: "No such price: price_123", type: "StripeInvalidRequestError" }, FB)).toBe(FB);
    expect(publicMessage("t", { message: "Invalid API Key provided: sk_test_***" }, FB)).toBe(FB);
    expect(publicMessage("t", new Error("fetch failed"), FB)).toBe(FB);
    expect(publicMessage("t", new Error("connect ECONNREFUSED 127.0.0.1:5432"), FB)).toBe(FB);
  });

  test("messages the app wrote itself pass through", () => {
    expect(publicMessage("t", new Error("Product not found"), FB)).toBe("Product not found");
    expect(publicMessage("t", new Error("Invalid amount (Stripe min 50¢)"), FB)).toBe(FB); // mentions Stripe: replaced, fine
    expect(publicMessage("t", new Error("This post does not sell that product."), FB)).toBe("This post does not sell that product.");
    expect(publicMessage("t", new Error("plan_months invalid"), FB)).toBe("plan_months invalid");
  });

  test("garbage in, fallback out", () => {
    expect(publicMessage("t", null, FB)).toBe(FB);
    expect(publicMessage("t", undefined, FB)).toBe(FB);
    expect(publicMessage("t", "a string", FB)).toBe(FB);
    expect(publicMessage("t", new Error(""), FB)).toBe(FB);
    expect(publicMessage("t", new Error("x".repeat(300)), FB)).toBe(FB);
  });
});

describe("source tripwires", () => {
  test("no API route returns a raw error.message to the browser", () => {
    const { execSync } = require("child_process") as typeof import("child_process");
    const out = execSync(
      'git ls-files "app/api/**/route.ts" "app/auth/**/route.ts"',
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    const offenders: string[] = [];
    for (const f of out) {
      const src = read(f);
      const re = /json\(\s*\{[^}]*(?:error|details|message):\s*[^}]*(?:\.message\b|String\(e\))/g;
      // allow console.* lines and the publicMessage wrapper itself
      const hits = (src.match(re) ?? []).filter((h) => !h.includes("publicMessage("));
      if (hits.length) offenders.push(`${f}: ${hits[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });

  test("bookings/list no longer ships Supabase hint/details/code", () => {
    const src = read("app/api/bookings/list/route.ts");
    expect(src).not.toMatch(/supabase:\s*\{\s*details,\s*hint,\s*code\s*\}/);
  });

  test("webhook error bodies carry the stage only", () => {
    expect(read("app/api/stripe/webhook/route.ts")).toMatch(/NextResponse\.json\(\{ ok: false, stage \}, \{ status \}\)/);
  });

  test("security headers are set on every route", () => {
    const cfg = read("next.config.ts");
    expect(cfg).toMatch(/async headers\(\)/);
    expect(cfg).toMatch(/source: "\/\(\.\*\)"/);
    for (const h of [
      ["X-Frame-Options", "DENY"],
      ["Content-Security-Policy", "frame-ancestors 'none'"],
      ["X-Content-Type-Options", "nosniff"],
      ["Referrer-Policy", "strict-origin-when-cross-origin"],
      ["Strict-Transport-Security", "max-age=63072000; includeSubDomains"],
    ]) {
      expect(cfg).toContain(`{ key: "${h[0]}", value: "${h[1]}" }`);
    }
    // no script/style CSP: that would need a nonce pipeline and can blank pages
    expect(cfg).not.toMatch(/script-src|style-src|default-src/);
  });
});
