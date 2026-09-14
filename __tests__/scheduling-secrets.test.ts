import { sealSchedulingSecret, openSchedulingSecret } from "@/lib/schedulingSecrets";
const originalKey = process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY;
beforeEach(() => { process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY = "ab".repeat(32); });
afterAll(() => {
  if (originalKey === undefined) delete process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY;
  else process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY = originalKey;
});
test("tokens round trip without plaintext in storage and use fresh nonces", () => {
  const context = "creator:calcom:access";
  const sealed = sealSchedulingSecret("private-access-token", context);
  expect(sealed).not.toContain("private-access-token");
  expect(openSchedulingSecret(sealed, context)).toBe("private-access-token");
  expect(sealSchedulingSecret("private-access-token", context)).not.toBe(sealed);
});
test.each(["other:calcom:access", "creator:calendly:access", "creator:calcom:refresh"])("ciphertext cannot be reused for %s", context => {
  const sealed = sealSchedulingSecret("token", "creator:calcom:access");
  expect(() => openSchedulingSecret(sealed, context)).toThrow();
});
test("tampering and wrong encryption keys are rejected", () => {
  const sealed = sealSchedulingSecret("token", "context");
  const parts = sealed.split(".");
  const ciphertext = Buffer.from(parts[3], "base64url");
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString("base64url");
  expect(() => openSchedulingSecret(parts.join("."), "context")).toThrow();
  process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY = "cd".repeat(32);
  expect(() => openSchedulingSecret(sealed, "context")).toThrow();
});
test.each(["", "short", "z".repeat(64)])("missing or invalid key fails closed", key => {
  process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY = key;
  expect(() => sealSchedulingSecret("token", "context")).toThrow("Scheduling encryption is not configured");
});
