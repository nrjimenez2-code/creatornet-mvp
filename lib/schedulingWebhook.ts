import { createHmac, timingSafeEqual } from "node:crypto";
export function verifySchedulingSignature(
  provider: "calendly" | "calcom",
  raw: string,
  header: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (!secret) return false;
  let signature = header,
    body = raw;
  if (provider === "calendly") {
    const parts = Object.fromEntries(
      header.split(",").map((part) => part.trim().split("=")),
    );
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > 180)
      return false;
    signature = parts.v1 ?? "";
    body = parts.t + "." + raw;
  }
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex"),
  );
}
