import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(): Buffer {
  const encoded = process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(encoded)) throw new Error("Scheduling encryption is not configured");
  return Buffer.from(encoded, "hex");
}

/** Bind ciphertext to its creator, provider and purpose so rows cannot be swapped. */
export function sealSchedulingSecret(value: string, context: string): string {
  if (!context || !value) throw new Error("Missing scheduling secret context");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function openSchedulingSecret(value: string, context: string): string {
  const parts = value.split(".");
  if (!context || parts.length !== 4 || parts[0] !== "v1" ||
      !parts.slice(1).every(part => /^[a-zA-Z0-9_-]+$/.test(part)))
    throw new Error("Invalid scheduling secret envelope");
  const nonce = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid scheduling secret envelope");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
}
