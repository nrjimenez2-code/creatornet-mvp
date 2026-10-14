import "server-only";
import {createHash} from "node:crypto";

/** Original checkout canonicalization, shared by hosted and manual selection. */
export function productCheckoutFingerprint(value: Record<string, string | number | null>): string {
  const canonical = Object.keys(value).sort()
    .map(key => `${key}=${String(value[key] ?? "")}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}
