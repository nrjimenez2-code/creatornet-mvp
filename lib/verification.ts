// lib/verification.ts — the blue "Authenticity" check, shared rules.
//
// Server-only: generateCode() uses Node crypto and nothing here should reach
// a browser bundle. Client code learns the instructions from the API response.
//
// Two badges, two meanings — keep them apart:
//   * PURPLE (components/VerifiedCreatorBadge.tsx) = "cleared to sell",
//     derived from Stripe Connect onboarding. Automatic.
//   * BLUE (components/AuthenticityBadge.tsx) = "this is really them",
//     granted by an admin after the creator proves control of the social
//     account they claim. That proof is what this file describes.
//
// The flow: creator asks for a code → puts it in their Instagram/TikTok bio →
// admin opens the profile link, sees the code, approves → badge appears.
// Approval can be revoked later (impersonation found, account sold, etc.).

import "server-only";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Where the creator places the code — THE ONE PLACE TO CHANGE THE CHANNEL
// ---------------------------------------------------------------------------
// The founder's flow mentioned an official Discord; none exists yet, and there
// is no email infrastructure either, so the default is a bio line on the
// platform the creator named. When a Discord/email channel arrives, change
// this constant (and the admin page's "how to check" hint) — nothing else.
export const VERIFICATION_INSTRUCTIONS =
  "Add this code anywhere in the bio of the account you listed, then leave it there until the check is done (usually within a few days). We'll open your profile, look for the code, and turn on your blue check. You can remove the code afterwards.";

// ---------------------------------------------------------------------------
// Platforms and handles
// ---------------------------------------------------------------------------
export const VERIFICATION_PLATFORMS = ["instagram", "tiktok"] as const;
export type VerificationPlatform = (typeof VERIFICATION_PLATFORMS)[number];

/** 1–30 chars of letters, digits, dot or underscore — both platforms' rules. */
const HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export function isVerificationPlatform(value: unknown): value is VerificationPlatform {
  return (
    typeof value === "string" &&
    (VERIFICATION_PLATFORMS as readonly string[]).includes(value)
  );
}

/**
 * Normalise a typed handle: trim whitespace and drop ONE leading "@" (people
 * paste "@name" constantly). Returns null when what is left is not a valid
 * handle, so callers cannot forget to check.
 */
export function normalizeHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.trim().replace(/^@/, "");
  return HANDLE_PATTERN.test(stripped) ? stripped : null;
}

/** Public profile URL an admin opens to look for the code. */
export function profileUrlFor(platform: VerificationPlatform, handle: string): string {
  const safe = encodeURIComponent(handle);
  return platform === "tiktok"
    ? `https://www.tiktok.com/@${safe}`
    : `https://www.instagram.com/${safe}/`;
}

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------
export const VERIFICATION_STATUSES = ["code_issued", "approved", "rejected", "revoked"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_DECISIONS = ["approve", "reject", "revoke"] as const;
export type VerificationDecision = (typeof VERIFICATION_DECISIONS)[number];

/** decision → the status it produces. */
export const DECISION_RESULT: Record<VerificationDecision, VerificationStatus> = {
  approve: "approved",
  reject: "rejected",
  revoke: "revoked",
};

/**
 * Which statuses a request may move FROM, per decision. Anything else is a
 * 409 at the API. Terminal states (rejected, revoked) never move again — the
 * creator simply requests a fresh code.
 */
export const ALLOWED_TRANSITIONS: Record<VerificationDecision, readonly VerificationStatus[]> = {
  approve: ["code_issued"],
  reject: ["code_issued"],
  revoke: ["approved"],
};

export function isVerificationDecision(value: unknown): value is VerificationDecision {
  return (
    typeof value === "string" &&
    (VERIFICATION_DECISIONS as readonly string[]).includes(value)
  );
}

export function canTransition(from: VerificationStatus, decision: VerificationDecision): boolean {
  return ALLOWED_TRANSITIONS[decision].includes(from);
}

/** Statuses that block a new request: one live code, or already verified. */
export const OPEN_STATUSES: readonly VerificationStatus[] = ["code_issued", "approved"];

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------
// 32 symbols, no 0/O or 1/I, so a code read off a phone screen cannot be
// mistyped. Exactly 32 means one random byte masked to 5 bits picks a symbol
// with no modulo bias.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUP_LENGTH = 4;
const CODE_GROUPS = 2;
export const CODE_PATTERN = /^CN-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

/** A fresh "CN-XXXX-XXXX" code from crypto-grade randomness. */
export function generateCode(): string {
  const bytes = randomBytes(CODE_GROUP_LENGTH * CODE_GROUPS);
  const symbols = Array.from(bytes, (byte) => CODE_ALPHABET[byte & 31]);
  const groups: string[] = [];
  for (let i = 0; i < CODE_GROUPS; i++) {
    groups.push(symbols.slice(i * CODE_GROUP_LENGTH, (i + 1) * CODE_GROUP_LENGTH).join(""));
  }
  return `CN-${groups.join("-")}`;
}
