/**
 * API hardening: id guards, booking-link rules, upload policy, and a
 * source-level tripwire that the unverified JWT decode does not come back.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { isSafeId, eitherIdFilter } from "@/lib/ids";
import { isSafeBookingTarget } from "@/lib/bookingUrl";
import {
  isAllowedUpload,
  safeExtension,
  maxBytesFor,
  MAX_VIDEO_BYTES,
  MAX_IMAGE_BYTES,
} from "@/lib/uploadPolicy";

const REPO_ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

describe("ids in PostgREST filters", () => {
  test("uuids and slugs pass", () => {
    expect(isSafeId("3f2c1a0e-9b7d-4c6a-8e5f-1a2b3c4d5e6f")).toBe(true);
    expect(isSafeId("prod_ABC123")).toBe(true);
    expect(isSafeId("my-product-1")).toBe(true);
  });

  test("filter metacharacters are rejected", () => {
    for (const bad of ["a,id.eq.b", "x)", "a.b", "a b", "", "a;drop", "💥", "a".repeat(129), 42, null]) {
      expect(isSafeId(bad)).toBe(false);
    }
  });

  test("eitherIdFilter builds the expected string and throws on unsafe input", () => {
    expect(eitherIdFilter(["product_id", "id"], "abc-1")).toBe("product_id.eq.abc-1,id.eq.abc-1");
    expect(() => eitherIdFilter(["product_id", "id"], "abc,creator_id.eq.me")).toThrow("Invalid id");
  });

  test("no route interpolates a raw id into .or() any more", () => {
    for (const file of ["app/api/checkout/route.ts", "app/api/bookings/[bookingId]/payment-link/route.ts"]) {
      expect(read(file)).not.toMatch(/\.or\(`[^`]*\$\{/);
      expect(read(file)).toMatch(/eitherIdFilter\(/);
    }
  });
});

describe("booking link rules", () => {
  test("what production already stores keeps working", () => {
    expect(isSafeBookingTarget("https://www.google.com")).toBe(true);
    expect(isSafeBookingTarget("https://testlink.com")).toBe(true);
    expect(isSafeBookingTarget("/api/book?creator_id=521c60be-b128-451c-96bd-a37faa0d4b7c")).toBe(true);
    expect(isSafeBookingTarget("https://calendly.com/someone/30min?month=2026-09")).toBe(true);
  });

  test("dangerous targets are refused", () => {
    expect(isSafeBookingTarget("https://abcd@gmail.com")).toBe(false); // credentials in URL
    expect(isSafeBookingTarget("http://example.com")).toBe(false);
    expect(isSafeBookingTarget("javascript:alert(1)")).toBe(false);
    expect(isSafeBookingTarget("data:text/html,hi")).toBe(false);
    expect(isSafeBookingTarget("//evil.com")).toBe(false);
    expect(isSafeBookingTarget("https://localhost")).toBe(false);
    expect(isSafeBookingTarget("not a url")).toBe(false);
    expect(isSafeBookingTarget("")).toBe(false);
    expect(isSafeBookingTarget(null)).toBe(false);
  });
});

describe("upload policy", () => {
  test("what the composer sends is allowed", () => {
    expect(isAllowedUpload("videos", "video/mp4")).toBe(true);
    expect(isAllowedUpload("videos", "video/quicktime")).toBe(true);
    expect(isAllowedUpload("videos", "video/webm")).toBe(true);
    expect(isAllowedUpload("thumbnails", "image/jpeg")).toBe(true); // canvas thumbnails
    expect(isAllowedUpload("thumbnails", "image/png")).toBe(true);
    expect(isAllowedUpload("thumbnails", "IMAGE/WEBP ")).toBe(true);
  });

  test("web content and executables are not", () => {
    for (const ct of ["text/html", "image/svg+xml", "application/javascript", "application/octet-stream", "", null]) {
      expect(isAllowedUpload("videos", ct)).toBe(false);
      expect(isAllowedUpload("thumbnails", ct)).toBe(false);
    }
    expect(isAllowedUpload("videos", "image/jpeg")).toBe(false); // wrong folder
    expect(isAllowedUpload("thumbnails", "video/mp4")).toBe(false);
  });

  test("extensions are sanitised", () => {
    expect(safeExtension("clip.MP4", "videos")).toBe("mp4");
    expect(safeExtension("clip.mov", "videos")).toBe("mov");
    expect(safeExtension("../../evil.html", "videos")).toBe("mp4");
    expect(safeExtension("pic.svg", "thumbnails")).toBe("jpg");
    expect(safeExtension("noext", "thumbnails")).toBe("jpg");
    expect(safeExtension(undefined, "videos")).toBe("mp4");
  });

  test("caps are 500 MB video, 10 MB image", () => {
    expect(maxBytesFor("videos")).toBe(MAX_VIDEO_BYTES);
    expect(maxBytesFor("thumbnails")).toBe(MAX_IMAGE_BYTES);
    expect(MAX_VIDEO_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("auth tripwires", () => {
  test("no route decodes a JWT by hand any more", () => {
    for (const file of [
      "app/api/bookings/[bookingId]/route.ts",
      "app/api/bookings/seed/route.ts",
      "app/api/bookings/[bookingId]/payment-link/route.ts",
    ]) {
      expect(read(file)).not.toMatch(/decodeUserId/);
    }
  });

  test("booking delete uses the verified helper", () => {
    expect(read("app/api/bookings/[bookingId]/route.ts")).toMatch(/getAuthenticatedUser\(req\)/);
  });

  test("confirm-purchase requires a signed-in buyer and checks ownership", () => {
    const src = read("app/api/confirm-purchase/route.ts");
    expect(src).toMatch(/status: 401/);
    expect(src).toMatch(/sessionBuyer !== user\.id/);
    expect(src).not.toMatch(/meta\.buyer_id \?\? null/);
  });

  test("purchases/by-session requires login, a recorded buyer, and a paid purchase", () => {
    const src = read("app/api/purchases/by-session/route.ts");
    expect(src).toMatch(/status: 401/);
    expect(src).toMatch(/!owner \|\| owner !== user\.id/);
    expect(src).toMatch(/purchase\.status !== "paid"/);
    expect(src).not.toMatch(/select\("\*"\)/);
  });

  test("confirm-purchase fails closed when the session names no buyer", () => {
    expect(read("app/api/confirm-purchase/route.ts")).toMatch(/!sessionBuyer \|\| sessionBuyer !== user\.id/);
  });

  test("bookings/seed no longer carries the manual cookie-decoding helpers", () => {
    const src = read("app/api/bookings/seed/route.ts");
    expect(src).not.toMatch(/extractAccessToken|normalizeBase64/);
  });

  test("the unauthenticated stripe/confirm route is gone", () => {
    expect(() => read("app/api/stripe/confirm/route.ts")).toThrow();
  });

  test("presign refuses types outside the policy", () => {
    expect(read("app/api/upload/presign/route.ts")).toMatch(/isAllowedUpload\(folder, contentType\)/);
  });

  test("analytics RPC migration checks the owner", () => {
    const sql = read("supabase/schema/008-analytics-rpcs-owner-only.sql");
    expect(sql).toMatch(/v_creator_id <> auth\.uid\(\)/);
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.creator_kpis[^;]*FROM PUBLIC, anon/);
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.creator_views_timeseries[^;]*FROM PUBLIC, anon/);
  });
});
